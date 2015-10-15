/* 
	pac-proxy.js: PAC file aware HTTP proxy utility

	Copyright (c) Jozsef Orosz - jozsef@orosz.name

*/

var http      = require('http'),
    https     = require('https'),
	url       = require('url'),
	util 	  = require('util'),
	net		  = require('net'),
	winston   = require('winston'),
	downloader  = require('./downloader'),
	emitter   = require('events');


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
	
	self.on('ready', function() {
		self.startServer();
	});
	
	self.init();
}

// Loads PAC file
PACProxy.prototype.init = function() {
	var self = this;
	
	var pacfile = self.options.pac;
	
	winston.debug('Attempting to get PAC file from %s', pacfile);
	
	downloader.get(pacfile,function(err,script){
		if (err) {
			winston.error('Error when getting PAC file &s, %s', pacfile, err);
			self.emit('error', new Error('PAC file download failed'));
		} else {	
			winston.info('PAC file &s has been received %s', pacfile, script);
			self.script = script;
			
			// Emit event when the PAC file is loaded
			self.emit('ready');
		}
	});
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
	if (!req.headers.host) winston.error("Bogus request without Host: header");
	
	var host = req.headers.host.split(':')[0] || 'localhost';
	var port = req.headers.host.split(':')[1] || '80';
	
	var httpVersion = req.httpVersion;
	
	// Find out what our target for this URL is and setup parameters based on the request	
	var pac = findProxyFor(req.url);
	winston.debug('Proxy for %s (host:%s) is %s',req.url,req.headers.host, pac);
	
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
	
	// Make HTTP request to the target
	winston.debug('Forwarded to %s, data: %s',url.format(target), target);
	
    var proxyReq = http.request(target);
	
	// Allow timeout to be set on proxied request (default is 2 minutes)
	if (this.options.timeout) proxyReq.timeout = this.options.timeout;
		
	// Set callback for response to pipe the response and set the response code
    proxyReq.on('response', function(proxyRes) {
		winston.debug('Response %d, headers: %s ',proxyRes.statusCode, proxyRes.headers);
		
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
		  winston.debug("Error on proxied HTTP connection %s",err.stack);
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
	var pac = findProxyFor('https://'+req.url);
	
	// Now  we need to make a TCP/IP connection to the target host and port
	winston.debug("Making TCP connection to %s:%s",pac.host,pac.port);
	var proxySocket = net.createConnection(pac.port,pac.host);
	
	// Handler for when the socket is connected
	proxySocket.on('connect', function () {
		winston.debug("Connected to %s:%s",pac.host,pac.port);
		
		// Now there's a difference between direct and indirect
        if (pac.direct) {
			// If we are direct we should first send back a response 
            reqSocket.write( "HTTP/" + httpVersion + " 200 Connection established\r\n\r\n" );
        } else {
			// But if we're using a proxy we shall first send a 'CONNECT' request 
			// For simplicity, we'll copy the same header we received
			proxySocket.write(bodyhead);
		}
	
		// Setup piping to send everything from the input to the proxy socket and vica-versa
		reqSocket.pipe(proxySocket);
		proxySocket.pipe(reqSocket);
	});
	
	// Handle error on target socket
	proxySocket.on('error', function ( err ) {
          reqSocket.write( "HTTP/" + httpVersion + " 500 Connection error\r\n\r\n" );
          reqSocket.end();
		  winston.debug("Error on proxied socket %s",err.stack);
    });
	
}


// Returns an object with parameters based on PAC settings for this URL
function findProxyFor(what) {
	
	// TODO: We should really call to the PAC script
	pac = 'DIRECT';
	
	parsed = url.parse(what);
	result = {
		path: parsed.path || '/',
		protocol: parsed.protocol || 'http:'
	};
	
	// Determine target host and port based on PAC response
	if (pac.lastIndexOf('DIRECT') === 0) {
		result.direct = true;
		result.host = parsed.hostname;
		result.port = parsed.port || ( parsed.protocol === 'https:' ? 443 : 80 );
	} else if (pac.lastIndexOf('PROXY ') === 0) {
		pac = pac.substring(7);
		result.direct = false;
		result.host = pac.split(':')[0],
		result.port = pac.split(':')[1] || ( parsed.protocol === 'https:' ? 443 : 80 );
	}
	
	return result;
}