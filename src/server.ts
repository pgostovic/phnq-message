import { diff } from 'deep-diff';
import http from 'http';
import WebSocket from 'ws';
import { MessageType } from './constants';
import { deserialize, serialize } from './serialize';

export class MessageServer {
  public onConnect: (conn: Connection) => void;
  public onMessage: (message: any, options: any) => any;
  private wss?: WebSocket.Server;

  constructor(httpServer: http.Server, path?: string) {
    this.wss = undefined;
    this.onConnect = () => {
      return;
    };
    this.onMessage = () => {
      return;
    };

    if (httpServer) {
      this.setHttpServer(httpServer, path);
    }
  }

  public setHttpServer(httpServer: http.Server, path: string = '/') {
    httpServer.on('upgrade', (request, socket) => {
      if (request.url !== path) {
        socket.destroy();
      }
    });

    // Create the WebSocket server
    this.wss = new WebSocket.Server({ server: httpServer });

    // When a connection is made...
    this.wss.on('connection', ws => {
      // Instantiate a Connection object to hold state
      let connection: Connection | undefined = new Connection();

      // Close socket from within the connection
      connection.onClose(() => {
        ws.close(1000, 'Closed by server');
      });

      // Notify of new connections
      this.onConnect(connection);

      const send = async (message: any) => {
        // Need this for multi responses
        await wait(0);
        ws.send(serialize(message));
      };

      // Handle incoming messages from client to connection
      ws.on('message', async (messageRaw: string) => {
        const { id, type, data } = deserialize(messageRaw);

        const resp = await this.onMessage(
          { type, data },
          {
            ...connection,
            send: async (respData: any) => {
              await send({ type: MessageType.Response, id, data: respData });
            },
          },
        );

        if (typeof resp === 'function') {
          const respDataIterator = resp();

          await send({ type: MessageType.MultiBegin, id, data: {} });

          let prev = null;

          for await (const respData of respDataIterator) {
            if (prev) {
              const inc = diff(prev, respData);
              // If increment size is less than raw size then send back the increment
              if (JSON.stringify(inc) < JSON.stringify(respData)) {
                await send({ type: MessageType.MultiIncrement, id, data: inc });
              } else {
                await send({
                  data: respData,
                  id,
                  type: MessageType.MultiResponse,
                });
              }
            } else {
              await send({
                data: respData,
                id,
                type: MessageType.MultiResponse,
              });
            }
            prev = respData;
          }

          await send({ type: MessageType.MultiEnd, id, data: {} });
        } else {
          const respData = resp;
          await send({ type: MessageType.Response, id, data: respData });
        }
      });

      ws.on('close', () => {
        if (connection) {
          connection.onCloses.forEach(onClose => onClose());
          connection.destroy();
        }
        connection = undefined;
      });
    });
  }
}

/* tslint:disable max-classes-per-file */
export class Connection {
  public onCloses: Set<() => void>;

  constructor() {
    this.onCloses = new Set();
  }

  public onClose(fn: () => void) {
    this.onCloses.add(fn);
  }

  public destroy() {
    this.onCloses.clear();
  }

  public send(respData: any) {
    console.log('send', respData);
  }
}

const wait = (millis: number) =>
  new Promise(resolve => {
    setTimeout(resolve, millis);
  });

export default MessageServer;