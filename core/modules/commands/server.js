/*\
title: $:/core/modules/commands/server.js
type: application/javascript
module-type: command

Serve tiddlers over http

\*/
(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

if($tw.node) {
	var util = require("util"),
		fs = require("fs"),
		url = require("url"),
		path = require("path"),
		http = require("http"),
        querystring = require('querystring');
}

exports.info = {
	name: "server",
	synchronous: true
};

function processPost(request, response, callback) {
    var queryData = "";
    if(typeof callback !== 'function') return null;

    if(request.method == 'POST') {
        request.on('data', function(data) {
            queryData += data;
            if(queryData.length > 1e6) {
                queryData = "";
                response.writeHead(413, {'Content-Type': 'text/plain'}).end();
                request.connection.destroy();
            }
        });

        request.on('end', function() {
            var data = querystring.parse(queryData);
            callback(data);
        });

    } else {
        response.writeHead(405, {'Content-Type': 'text/plain'});
        response.end();
    }
}

var token;

function getParams(req){
  var q = req.url.split('?'), result = {};
  if(q.length >= 2) {
      return querystring.parse(q[1]);
  }
  return result;
}

/*
A simple HTTP server with regexp-based routes
*/
function SimpleServer(options) {
	this.routes = options.routes || [];
	this.wiki = options.wiki;
	this.variables = options.variables || {};
}

SimpleServer.prototype.set = function(obj) {
	var self = this;
	$tw.utils.each(obj,function(value,name) {
		self.variables[name] = value;
	});
};

SimpleServer.prototype.get = function(name) {
	return this.variables[name];
};

SimpleServer.prototype.addRoute = function(route) {
	this.routes.push(route);
};

SimpleServer.prototype.findMatchingRoute = function(request,state) {
	var pathprefix = this.get("pathprefix") || "";
	for(var t=0; t<this.routes.length; t++) {
		var potentialRoute = this.routes[t],
			pathRegExp = potentialRoute.path,
			pathname = state.urlInfo.pathname,
			match;
		if(pathprefix) {
			if(pathname.substr(0,pathprefix.length) === pathprefix) {
				pathname = pathname.substr(pathprefix.length);
				match = potentialRoute.path.exec(pathname);
			} else {
				match = false;
			}
		} else {
			match = potentialRoute.path.exec(pathname);
		}
		if(match && request.method === potentialRoute.method) {
			state.params = [];
			for(var p=1; p<match.length; p++) {
				state.params.push(match[p]);
			}
			return potentialRoute;
		}
	}
	return null;
};

SimpleServer.prototype.checkCredentials = function(request,incomingUsername,incomingPassword) {
	var header = request.headers.authorization || "",
		token = header.split(/\s+/).pop() || "",
		auth = $tw.utils.base64Decode(token),
		parts = auth.split(/:/),
		username = parts[0],
		password = parts[1];
	if(incomingUsername === username && incomingPassword === password) {
		return "ALLOWED";
	} else {
		return "DENIED";
	}
};

SimpleServer.prototype.requestHandler = function(request,response) {
	// Compose the state object
	var self = this;
	var state = {};
	state.wiki = self.wiki;
	state.server = self;
	state.urlInfo = url.parse(request.url);
	// Find the route that matches this path
	var route = self.findMatchingRoute(request,state);
	// Check for the username and password if we've got one
	var username = self.get("username"),
		password = self.get("password");
	if(username && password) {
		// Check they match
		if(self.checkCredentials(request,username,password) !== "ALLOWED") {
			var servername = state.wiki.getTiddlerText("$:/SiteTitle") || "TiddlyWiki5";
			response.writeHead(401,"Authentication required",{
				"WWW-Authenticate": 'Basic realm="Please provide your username and password to login to ' + servername + '"'
			});
			response.end();
			return;
		}
	}
	// Return a 404 if we didn't find a route
	if(!route) {
		response.writeHead(404);
		response.end();
		return;
	}
	// Set the encoding for the incoming request
	// TODO: Presumably this would need tweaking if we supported PUTting binary tiddlers
	request.setEncoding("utf8");
	// Dispatch the appropriate method
	switch(request.method) {
		case "GET": // Intentional fall-through
        case "POST": // Intentional fall-through
		case "DELETE":
			route.handler(request,response,state);
			break;
		case "PUT":
			var data = "";
			request.on("data",function(chunk) {
				data += chunk.toString();
			});
			request.on("end",function() {
				state.data = data;
				route.handler(request,response,state);
			});
			break;
	}
};
	
SimpleServer.prototype.listen = function(port,host) {
	http.createServer(this.requestHandler.bind(this)).listen(port,host);
};

var Command = function(params,commander,callback) {
	this.params = params;
	this.commander = commander;
	this.callback = callback;
	// Set up server
	this.server = new SimpleServer({
		wiki: this.commander.wiki
	});
	// Add route handlers
	this.server.addRoute({
		method: "PUT",
		path: /^\/recipes\/default\/tiddlers\/(.+)$/,
		handler: function(request,response,state) {
			var title = decodeURIComponent(state.params[0]),
				fields = JSON.parse(state.data);
			// Pull up any subfields in the `fields` object
			if(fields.fields) {
				$tw.utils.each(fields.fields,function(field,name) {
					fields[name] = field;
				});
				delete fields.fields;
			}
			// Remove any revision field
			if(fields.revision) {
				delete fields.revision;
			}
			state.wiki.addTiddler(new $tw.Tiddler(state.wiki.getCreationFields(),fields,{title: title},state.wiki.getModificationFields()));
			var changeCount = state.wiki.getChangeCount(title).toString();
			response.writeHead(204, "OK",{
				Etag: "\"default/" + encodeURIComponent(title) + "/" + changeCount + ":\"",
				"Content-Type": "text/plain"
			});
			response.end();
		}
	});
	this.server.addRoute({
		method: "DELETE",
		path: /^\/bags\/default\/tiddlers\/(.+)$/,
		handler: function(request,response,state) {
			var title = decodeURIComponent(state.params[0]);
			state.wiki.deleteTiddler(title);
			response.writeHead(204, "OK", {
				"Content-Type": "text/plain"
			});
			response.end();
		}
	});
	this.server.addRoute({
		method: "GET",
		path: /^\/$/,
		handler: function(request,response,state) {
			response.writeHead(200, {"Content-Type": state.server.get("serveType")});
			var text = state.wiki.renderTiddler(state.server.get("renderType"),state.server.get("rootTiddler"));
			response.end(text,"utf8");
		}
	});
    this.server.addRoute({
        method: "POST",
        path: /^\/api\/login$/,
        handler: function(request,response,state) {
            processPost(request, response, function(data) {
                var username = data.username;
                var password = data.password;
                var json = {};
                if(username === state.server.get("username") && password === state.server.get("password")) {
                    token = "" + Date.now();
                    json = {
                        status: "OK",
                        message: "Login Succeeded",
                        token: token,
                    };
                }
                else {
                    json = {
                        status: "ERROR",
                        message: "Login Failed",
                    };
                }

                response.writeHead(200, {"Content-Type": "application/json"});
                response.end(JSON.stringify(json),"utf8");
            });
        }
    });
    this.server.addRoute({
        method: "GET",
        path: /^\/api\/get\/(.+)$/,
        handler: function(request, response, state) {
            var title = decodeURIComponent(state.params[0]);
            var json = {};
            var params = getParams(request) || {};
            var t = params.token;
            if(token === t) {
                if(title) {
                    var tiddler = state.wiki.getTiddler(title);
                    if(tiddler) {
                        $tw.utils.each(tiddler.fields,function(field,name) {
                            json[name] = tiddler.getFieldString(name);
                        });
                        json.revision = state.wiki.getChangeCount(title);
                        json.type = json.type || "text/vnd.tiddlywiki";
                    }
                }
            }

            response.writeHead(200, {"Content-Type": "application/json"});
            response.end(JSON.stringify(json),"utf8");
        }
    });
    this.server.addRoute({
        method: "GET",
        path: /^\/api\/query\/(.+)$/,
        handler: function(request, response, state) {
            var query = decodeURIComponent(state.params[0]);
            var json = {};
            var params = getParams(request) || {};
            var t = params.token;
            if(token === t) {
                if(query) {
                    var titles = state.wiki.filterTiddlers(query);
                    json = titles;
                }
            }

            response.writeHead(200, {"Content-Type": "application/json"});
            response.end(JSON.stringify(json),"utf8");
        }
    });
    this.server.addRoute({
        method: "POST",
        path: /^\/api\/save\/(.+)$/,
        handler: function(request,response,state) {
            processPost(request, response, function(data) {
                var json = {};
                var params = getParams(request) || {};
                var t = params.token;
                if(token === t) {
                    var title = decodeURIComponent(state.params[0]);
                    var tiddler = state.wiki.getTiddler(title);

                    if(tiddler) {
                        state.wiki.addTiddler(new $tw.Tiddler(state.wiki.getCreationFields(),
                            tiddler,
                            data,
                            state.wiki.getModificationFields()));
                    }
                    else {
                        state.wiki.addTiddler(new $tw.Tiddler(state.wiki.getCreationFields(),
                            data,
                            state.wiki.getModificationFields()));
                    }

                    json = {
                        status: "OK",
                        message: "Save Success",
                    };
                }
                else {
                    json = {
                        status: "ERROR",
                        message: "Invalid token",
                    };
                }

                response.writeHead(200, {"Content-Type": "application/json"});
                response.end(JSON.stringify(json),"utf8");
            });
        }
    });
    this.server.addRoute({
        method: "GET",
        path: /^\/api\/delete\/(.+)$/,
        handler: function(request, response, state) {
            var title = decodeURIComponent(state.params[0]);
            var json = {};
            var params = getParams(request) || {};
            var t = params.token;
            if(token === t) {
                if(title) {
                    var tiddler = state.wiki.getTiddler(title);
                    if(tiddler) {
                        state.wiki.deleteTiddler(title);

                        json = {
                            status: "OK",
                            message: "Delete Success",
                        };
                    }
                }
            }

            response.writeHead(200, {"Content-Type": "application/json"});
            response.end(JSON.stringify(json),"utf8");
        }
    });
	this.server.addRoute({
		method: "GET",
		path: /^\/status$/,
		handler: function(request,response,state) {
			response.writeHead(200, {"Content-Type": "application/json"});
			var text = JSON.stringify({
				username: state.server.get("username"),
				space: {
					recipe: "default"
				},
				tiddlywiki_version: $tw.version
			});
			response.end(text,"utf8");
		}
	});
	this.server.addRoute({
		method: "GET",
		path: /^\/favicon.ico$/,
		handler: function(request,response,state) {
			response.writeHead(200, {"Content-Type": "image/x-icon"});
			var buffer = state.wiki.getTiddlerText("$:/favicon.ico","");
			response.end(buffer,"base64");
		}
	});
	this.server.addRoute({
		method: "GET",
		path: /^\/recipes\/default\/tiddlers.json$/,
		handler: function(request,response,state) {
			response.writeHead(200, {"Content-Type": "application/json"});
			var tiddlers = [];
			state.wiki.forEachTiddler({sortField: "title"},function(title,tiddler) {
				var tiddlerFields = {};
				$tw.utils.each(tiddler.fields,function(field,name) {
					if(name !== "text") {
						tiddlerFields[name] = tiddler.getFieldString(name);
					}
				});
				tiddlerFields.revision = state.wiki.getChangeCount(title);
				tiddlerFields.type = tiddlerFields.type || "text/vnd.tiddlywiki";
				tiddlers.push(tiddlerFields);
			});
			var text = JSON.stringify(tiddlers);
			response.end(text,"utf8");
		}
	});
	this.server.addRoute({
		method: "GET",
		path: /^\/recipes\/default\/tiddlers\/(.+)$/,
		handler: function(request,response,state) {
			var title = decodeURIComponent(state.params[0]),
				tiddler = state.wiki.getTiddler(title),
				tiddlerFields = {},
				knownFields = [
					"bag", "created", "creator", "modified", "modifier", "permissions", "recipe", "revision", "tags", "text", "title", "type", "uri"
				];
			if(tiddler) {
				$tw.utils.each(tiddler.fields,function(field,name) {
					var value = tiddler.getFieldString(name);
					if(knownFields.indexOf(name) !== -1) {
						tiddlerFields[name] = value;
					} else {
						tiddlerFields.fields = tiddlerFields.fields || {};
						tiddlerFields.fields[name] = value;
					}
				});
				tiddlerFields.revision = state.wiki.getChangeCount(title);
				tiddlerFields.type = tiddlerFields.type || "text/vnd.tiddlywiki";
				response.writeHead(200, {"Content-Type": "application/json"});
				response.end(JSON.stringify(tiddlerFields),"utf8");
			} else {
				response.writeHead(404);
				response.end();
			}
		}
	});
};

Command.prototype.execute = function() {
	if(!$tw.boot.wikiTiddlersPath) {
		$tw.utils.warning("Warning: Wiki folder '" + $tw.boot.wikiPath + "' does not exist or is missing a tiddlywiki.info file");
	}
	var port = this.params[0] || "8080",
		rootTiddler = this.params[1] || "$:/core/save/all",
		renderType = this.params[2] || "text/plain",
		serveType = this.params[3] || "text/html",
		username = this.params[4],
		password = this.params[5],
		host = this.params[6] || "127.0.0.1",
		pathprefix = this.params[7];
	this.server.set({
		rootTiddler: rootTiddler,
		renderType: renderType,
		serveType: serveType,
		username: username,
		password: password,
		pathprefix: pathprefix
	});
	this.server.listen(port,host);
	console.log("Serving on " + host + ":" + port);
	console.log("(press ctrl-C to exit)");
	// Warn if required plugins are missing
	if(!$tw.wiki.getTiddler("$:/plugins/tiddlywiki/tiddlyweb") || !$tw.wiki.getTiddler("$:/plugins/tiddlywiki/filesystem")) {
		$tw.utils.warning("Warning: Plugins required for client-server operation (\"tiddlywiki/filesystem\" and \"tiddlywiki/tiddlyweb\") are missing from tiddlywiki.info file");
	}
	return null;
};

exports.Command = Command;

})();
