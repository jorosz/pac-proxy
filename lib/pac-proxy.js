/* 
	pac-proxy.js: PAC file aware HTTP proxy utility

	Copyright (c) Jozsef Orosz - jozsef@orosz.name

*/

var http      	= require('http'),
    https     	= require('https'),
	url       	= require('url'),
	util 	  	= require('util'),
	net		  	= require('net'),
	winston   	= require('winston'),
	downloader  = require('./downloader'),
	vm 			= require('vm'),
	Q		  	= require('q'),
	emitter  	= require('events');


// Factory method to create a new instance of the proxy server
module.exports.createProxy = function createProxy(options) {
	
	winston.info("Creating new instance of PAC Proxy");
	// Instantiate the PACProxy class
	var proxy = new PACProxy(options); 
	return proxy;
	
}

// Constructor for the PACProxy server.
function PACProxy(options) {
	winston.debug("Entering constructor for PACProxy");
	
	// Copy options
	this.options = options || {};
	
	// Init event emitter
	emitter.call(this);

	// End 
	return this;
}

util.inherits(PACProxy,emitter);

PACProxy.prototype.start = function() {
	var self = this;
	
	self
	.init()
	.then(function() { self.parsePAC() }) 		// Need closures for object reference
	.then(function() { self.startServer() })
	.done();

}

// Loads PAC file
PACProxy.prototype.init = function() {
	var self = this;
	var deferred = Q.defer();
	
	var pacfile = self.options.pac;
	
	winston.info('Downloading PAC file from %s', pacfile);
	
	downloader
	.get(pacfile)
	.then(function(script) {
		winston.debug("Got PAC Script:\n %s",script);
		self.script = script;
		deferred.resolve(true);
	})
	.catch(function(err) {
		winston.error('Error when getting PAC file %s, %s', pacfile, err);
		self.emit('error', new Error('PAC file download failed'));	
		deferred.reject(err);	
	});
	
	return deferred.promise;
}


PACProxy.prototype.parsePAC = function() {
	var self = this;
	var deferred = Q.defer();
							
	var sandbox =  {
 		dateRange: require('pac-resolver/dateRange'),
   		dnsDomainIs: require('pac-resolver/dnsDomainIs'),
  		dnsDomainLevels: require('pac-resolver/dnsDomainLevels'),
   		dnsResolve: require('pac-resolver/dnsResolve'),
   		isInNet: require('pac-resolver/isInNet'),
   		isPlainHostName: require('pac-resolver/isPlainHostName'),
   		isResolvable: require('pac-resolver/isResolvable'),
    	localHostOrDomainIs: require('pac-resolver/localHostOrDomainIs'),
   		myIpAddress: require('pac-resolver/myIpAddress'),
    	shExpMatch: require('pac-resolver/shExpMatch'),
    	timeRange: require('pac-resolver/timeRange'),
   		weekdayRange: require('pac-resolver/weekdayRange')
  	};
			
	// Run the PAC script and get the handle for the function
	try {
		var fn = vm.runInNewContext(self.script + ';FindProxyForURL', sandbox);
		self.findProxyForURL = fn;
		
		winston.info('PAC file has been loaded');
			
		// Emit event that the PAC file is loaded
		self.emit('ready');
	
		// Okay, this doesn't make much sense since nothing is async in this method
		deferred.resolve();
	} catch (e)	{
		deferred.reject(e);
	}
			
	return deferred.promise;
}

// Starts the web server
PACProxy.prototype.startServer = function() {
	var self = this;
	
	// Create our HTTP server as per the options and bind the two processing functions
	var server = http.createServer(function(req,res) {
		self.handleHTTP(req,res)
	});
	
	// We'll need to add a listener to the 'CONNECT' request for SSL forwarding
	server.addListener('connect', function(req, socketReq, body) {
		self.handleConnect(req,socketReq,body)
	});
	
	self.server = server;
	server.listen(self.options.port);
	winston.info("HTTP server is now started");
	
	// Emit server started event
	self.emit('started',server);
}


// Method for handling plain HTTP requests
PACProxy.prototype.handleHTTP = function(req,res) {	
	winston.debug("Received HTTP %s request for %s from %s (headers: %s)", req.method, req.url, req.connection.remoteAddress, req.headers);

	// We should find out the full URL
	if (!req.headers.host) winston.warn("Bogus request without Host: header");
	
	var host = req.headers.host.split(':')[0] || 'localhost';
	var port = req.headers.host.split(':')[1] || '80';
	
	var httpVersion = req.httpVersion;
	
	// Find out what our target for this URL is and setup parameters based on the request	
	var pac = this.findProxyFor(req.url);
	
	var target = {
		protocol: pac.protocol,
		method: req.method || 'GET',
		host: pac.host,
		port: pac.port,
		path: pac.path
	}
	
	// This allows setting custom headers in options.headers
	target.headers = util._extend(this.options.headers ? this.options.headers : {} , req.headers); 
	
	// Use the same keep-alive setting as the original request
	// TODO: May need to fiddle with 'Agent' settings for Keep-Alive
	if (req.headers.connection) target.headers.connection = req.headers.connection; 
	
	winston.info('HTTP %s for %s via %s:%s from %s',req.method, req.url, target.host, target.port ,req.connection.remoteAddress);

	// Make HTTP request to the target
	winston.debug('Forwarding to %s, data: ',url.format(target), target);
    var proxyReq = http.request(target);
	
	// Allow timeout to be set on proxied request (default is 2 minutes)
	if (this.options.timeout) proxyReq.timeout = this.options.timeout;
		
	// Set callback for response to pipe the response and set the response code
    proxyReq.on('response', function(proxyRes) {
		winston.debug('Got response %d :',proxyRes.statusCode, proxyRes.headers);
		
		// Copy response headers and status code
		res.writeHead(proxyRes.statusCode, proxyRes.headers);
		
	 	// Pipe response back to the original request
      	proxyRes.pipe(res);
    });
	
	// Setup an error handler in case the connection fails to the target
	proxyReq.on('error', function ( err ) {
		  res.writeHead(500,'Connection error');
		  res.end();
          proxyReq.abort();	
		  winston.warn('Error on %s for %s via %s:%s',req.method, req.url, target.host, target.port, err);
    });
		
	// Finally - setup a pipe for the request to the target
	req.pipe(proxyReq);
	
}

// Method for handling CONNECT requests. 
// If we're using a PROXY we should send the very same CONNECT request then pipe the traffic
// For DIRECT we should make a socket connection and then pipe the traffic
PACProxy.prototype.handleConnect = function(req, reqSocket, bodyhead) {
	winston.debug("Received CONNECT request to %s from %s", req.url, req.connection.remoteAddress);
    
    var httpVersion = req.httpVersion || '1.1';
	var pac = this.findProxyFor('https://'+req.url);
	
	// Now  we need to make a TCP/IP connection to the target host and port
	winston.debug("Making TCP connection to %s:%s",pac.host,pac.port);
	var proxySocket = net.createConnection(pac.port,pac.host);
    proxySocket.setKeepAlive(true);
    reqSocket.setKeepAlive(true);
	
	// Handler for when the socket is connected
	proxySocket.on('connect', function () {
		
		winston.debug("Connected to %s:%s",pac.host,pac.port);
		winston.info('Using %s for %s via %s:%s from %s',req.method, req.url, pac.host, pac.port ,req.connection.remoteAddress);
		
		
		// Now there's a difference between direct and indirect
        if (pac.direct) {
			// If we are direct we should first send back a response 
            reqSocket.write( "HTTP/" + httpVersion + " 200 Connection established\r\n\r\n" );
			// Setup piping to send everything from the input to the proxy socket and vica-versa
			reqSocket.pipe(proxySocket);
			proxySocket.pipe(reqSocket);
        } else {
			proxySocket.pipe(reqSocket);
			
			// But if we're using a proxy we shall first send a 'CONNECT' request 
			var constr = "CONNECT "+req.url+" HTTP/"+ httpVersion + "\r\n";
			// This requires us to re-create headers we got so far
			for (var i=0; i < req.rawHeaders.length; i+=2) 
				constr += req.rawHeaders[i] + ": " + req.rawHeaders[i+1] + "\r\n";
			winston.debug("Sending: %s", constr);
			proxySocket.write(constr);
			reqSocket.pipe(proxySocket);
		}	

	});
	
	// Handle error on target socket
	proxySocket.on('error', function ( err ) {
          reqSocket.write( "HTTP/" + httpVersion + " 500 Connection error\r\n\r\n" );
          reqSocket.end();
		  winston.warn("Error on proxied socket %s",err.stack);
    });
	
}


// Returns an object with parameters based on PAC settings for this URL
PACProxy.prototype.findProxyFor = function(what) {	
	var self = this;
	
	var parsed = url.parse(what);
	var result = {
		protocol: parsed.protocol || 'http:'
	};

	var pac = self.findProxyForURL(what,parsed.hostname);
	winston.debug("Proxy lookup for %s %s is %s",what,parsed.hostname,pac);
	
	// Determine target host and port based on PAC response
	if (pac.lastIndexOf('DIRECT') === 0) {
		result.direct = true;
		result.path = parsed.path || '/';
		result.host = parsed.hostname;
		result.port = parsed.port || ( parsed.protocol === 'https:' ? 443 : 80 );
	} else if (pac.lastIndexOf('PROXY ') === 0) {
		pac = pac.substring(6);
		result.path = url.format(parsed); // Apparently for proxy this must be the full URL
		result.direct = false;
		result.host = pac.split(':')[0],
		result.port = pac.split(':')[1] || ( parsed.protocol === 'https:' ? 443 : 80 );
	}
	
	return result;
}