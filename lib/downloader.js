/* 
	get-file.js: Tool to get a file from the web into a string

	Copyright (c) Jozsef Orosz - jozsef@orosz.name

*/

var http      = require('http'),
    https     = require('https'),
	Q		  = require('q'),
	winston   = require('winston');	
	
// Reads given URL and invokes callback
// Callback should be a function which gets (err,result)
// Now uses promises to support better processing
// Note: I didn't use the request library because that would take PROXY settings into account which in 
// turn would redirect to us
// TODO Add handling of 30x redirects
exports.get = function(loc) {
	var deferred = Q.defer();
	
	// Make a get request
	var req = (loc.match('/^https:/') ? https : http).get(loc, function (res) {
		// We have a response of some kind
		var body = '';
		
		// Save what the response is
        res.on('data', function(d) {
            body += d;	// FIXME String concat may not be best for performance
        });
		
		// In the end set the promise
        res.on('end', function() {
			if (res.statusCode === 200) {
				deferred.resolve(body)
			} else {
				deferred.reject(new Error('download error - HTTP'+res.statusCode));
			}
		});				
	});
	
	req.on('error',function(err) {
		deferred.reject(err);
	});
	
	req.end();
	
	return deferred.promise;
    
}
