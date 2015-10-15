/* 
	proxy.js: PAC file aware HTTP proxy utility - Main program

	Copyright (c) Jozsef Orosz - jozsef@orosz.name

*/


var PACProxy = require('./lib/pac-proxy'),
	winston   = require('winston');

	
winston.cli();
winston.level = 'debug';


var options = { 
		port: 8001,
		pac: 'http://myapps.setpac.ge.com/pac.pac'
};

var proxy = PACProxy.createProxy(options);
	
proxy.start();
