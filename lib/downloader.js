/* 
	get-file.js: Tool to get a file from the web into a string

	Copyright (c) Jozsef Orosz - jozsef@orosz.name

*/

var http      = require('http'),
    https     = require('https'),
	winston   = require('winston'),
	emitter   = require('events');
	
	
// Reads given URL and invokes callback
// Callback should be a function which gets (err,result)
// TODO Use events rather than callback
// TODO Add handling of 30x redirects
exports.get = function(loc, callback) {
		
	// Make a get request
	var req = (loc.match('/^https:/') ? https : http).get(loc, function (res) {
		// We have a response of some kind
		var body = '';
		
		// Save what the response is
        res.on('data', function(d) {
			// TODO This may not be best for performance
            body += d;
        });
		
		// In the end invoke the callback
        res.on('end', function() {
			if (res.statusCode === 200) {
				callback(null,body)
			} else {
				callback(new Error('download error - HTTP'+res.statusCode),null);
			}
		});				
	});
	
	req.on('error',function(err) {
		callback(err,null);
	});
	
	req.end();
    
}
