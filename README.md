# pac-proxy
pac-proxy is a utility to run a local HTTP(s) proxy server which directs traffic based on a proxy autoconfig (PAC) file. 

Some large companies may be using very complicated rules for web proxy access in PAC files and therefore it may be very 
complex to properly set `HTTP_PROXY` and `HTTPS_PROXY` variables. The intent of this utility is to enable simple configuration by running this proxy
on the local machine and using `localhost` as the HTTP proxy.


