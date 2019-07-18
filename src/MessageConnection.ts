import { createLogger } from '@phnq/log';
import { AsyncQueue } from '@phnq/streams';
import uuid from 'uuid/v4';
import { Anomaly } from './Anomaly';
import { IAnomalyMessage, IErrorMessage, IMessage, IMessageTransport, MessageType } from './MessageTransport';

const log = createLogger('MessageConnection');

const idIterator = (function*() {
  let i = 0;
  while (true) {
    yield ++i;
  }
})();

export type IValue = string | number | boolean | Date | IData | undefined;

export interface IData {
  [key: string]: IValue | IValue[];
}

export class MessageConnection {
  private uuid = uuid();
  private transport: IMessageTransport;
  private responseQueues = new Map<number, AsyncQueue<IMessage>>();
  private receive?: (message: any) => AsyncIterableIterator<IValue> | Promise<IValue>;

  constructor(transport: IMessageTransport) {
    this.transport = transport;

    transport.onReceive(message => {
      const responseQueue = this.responseQueues.get(message.id);
      switch (message.type) {
        case MessageType.Request:
          this.handleRequest(message);
          break;

        case MessageType.Response:
        case MessageType.Anomaly:
        case MessageType.Error:
          if (responseQueue) {
            responseQueue.enqueue(message);
          }
          break;

        case MessageType.End:
          if (responseQueue) {
            responseQueue.flush();
          }
          break;
      }
    });
  }

  public get id() {
    return this.uuid;
  }

  public async requestOne<R = any>(data: any): Promise<R> {
    const resps: R[] = [];

    for await (const resp of await this.request(data)) {
      resps.push(resp);
    }

    if (resps.length > 1) {
      log('requestOne: multiple responses were returned -- all but the first were discarded');
    }

    return resps[0];
  }

  public async request<R = any>(data: any): Promise<AsyncIterableIterator<R>> {
    const id = idIterator.next().value;

    const responseQueue = new AsyncQueue<IMessage>();
    this.responseQueues.set(id, responseQueue);

    await this.transport.send({ type: MessageType.Request, id, data });

    return (async function*() {
      for await (const message of responseQueue.iterator()) {
        switch (message.type) {
          case MessageType.Anomaly:
            const anomalyMessage = message as IAnomalyMessage;
            throw new Anomaly(anomalyMessage.data.message, anomalyMessage.data.info);

          case MessageType.Error:
            throw new Error((message as IErrorMessage).data.message);
        }
        yield message.data;
      }
    })();
  }

  public onReceive<R>(receive: (message: R) => AsyncIterableIterator<IValue> | Promise<IValue>) {
    this.receive = receive;
  }

  private async handleRequest(message: IMessage) {
    if (!this.receive) {
      throw new Error('No receive handler set.');
    }

    try {
      const result = this.receive(message.data);

      const respIter =
        result instanceof Promise
          ? (async function*() {
              yield await result;
            })()
          : result;

      for await (const resp of respIter) {
        this.transport.send({ id: message.id, type: MessageType.Response, data: resp });
      }
    } catch (err) {
      if (err instanceof Anomaly) {
        this.transport.send({
          data: { message: err.message, info: err.info },
          id: message.id,
          type: MessageType.Anomaly,
        });
      } else if (err instanceof Error) {
        this.transport.send({
          data: { message: err.message },
          id: message.id,
          type: MessageType.Error,
        });
      } else {
        throw new Error('Errors should only throw instances of Error and Anomaly.');
      }
    }
    this.transport.send({ id: message.id, type: MessageType.End, data: {} });
  }
}