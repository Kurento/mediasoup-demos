const Util = require("util");

const JsonRpcClient = require('@transfast/jsonrpcclient')

const methodsFactory = require('./methods')


module.exports = function(CONFIG)
{
  let _jsonRpcClient
  let _socket


  function onClose()
  {
    delete _jsonRpcClient;
  }

  function send(data)
  {
    _socket?.send(JSON.stringify(data))
  }


  // Logging
  // =======

  // Send all logging to both console and WebSocket
  for (const name of ["debug", "log", "info", "warn", "error"]) {
    const method = console[name];

    console[name] = function (...args) {
      method(...args);

      send(_jsonRpcClient?.notification("LOG", [Util.format(...args)]));
    };
  }


  const methods = methodsFactory(CONFIG)


  return function(socket, request)
  {
    console.log(
      "WebSocket server connected, port: %s",
      request.connection.remotePort
    );

    const jsonRpcClient = JsonRpcClient(methods, send)

    // Accept requests only from a single client
    // TODO fail on HTTP upgrade with 409 CONFLICT or 423 LOCKED
    if(_jsonRpcClient)
    {
      socket.send(JSON.stringify(jsonRpcClient.notification("error",
        ['Client already connected'])));

      return socket.close()
    }

    socket.addEventListener("close", onClose);
    socket.addEventListener("message", function({data})
    {
      console.log('message', data)
      jsonRpcClient.onMessage(JSON.parse(data))
    });

    _jsonRpcClient = jsonRpcClient;
    _socket = socket;
  }
}
