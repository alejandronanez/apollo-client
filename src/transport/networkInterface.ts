import 'whatwg-fetch';

import {
  ExecutionResult,
  DocumentNode,
} from 'graphql';

import { print } from 'graphql-tag/printer';

import { MiddlewareInterface } from './middleware';
import { AfterwareInterface } from './afterware';

/**
 * This is an interface that describes an GraphQL document to be sent
 * to the server.
 *
 * @param query The GraphQL document to be sent to the server. Note that this can
 * be a mutation document or a query document.
 *
 * @param variables An object that maps from variable names to variable values. These variables
 * can be referenced within the GraphQL document.
 *
 * @param operationName The name of the query or mutation, extracted from the GraphQL document.
 */
export interface Request {
  debugName?: string;
  query?: DocumentNode;
  variables?: Object;
  operationName?: string;
  [additionalKey: string]: any;
}

// The request representation just before it is converted to JSON
// and sent over the transport.
export interface PrintedRequest {
  debugName?: string;
  query?: string;
  variables?: Object;
  operationName?: string;
}

export interface NetworkInterface {
  [others: string]: any;
  query(request: Request): Promise<ExecutionResult>;
}

export interface BatchedNetworkInterface extends NetworkInterface {
  batchQuery(requests: Request[]): Promise<ExecutionResult[]>;
}

// XXX why does this have to extend network interface? does it even have a 'query' function?
export interface SubscriptionNetworkInterface extends NetworkInterface {
  subscribe(request: Request, handler: (error: any, result: any) => void): number;
  unsubscribe(id: Number): void;
}

export interface HTTPNetworkInterface extends NetworkInterface {
  _uri: string;
  _opts: RequestInit;
  _middlewares: MiddlewareInterface[];
  _afterwares: AfterwareInterface[];
  use(middlewares: MiddlewareInterface[]): HTTPNetworkInterface;
  useAfter(afterwares: AfterwareInterface[]): HTTPNetworkInterface;
}

export interface RequestAndOptions {
  request: Request;
  options: RequestInit;
}

export interface ResponseAndOptions {
  response: IResponse;
  options: RequestInit;
}

export function printRequest(request: Request): PrintedRequest {
  return {
    ...request,
    query: print(request.query),
  };
}

// TODO: refactor
// add the batching to this.
export class HTTPFetchNetworkInterface implements NetworkInterface {
  public _uri: string;
  public _opts: RequestInit;
  public _middlewares: MiddlewareInterface[];
  public _afterwares: AfterwareInterface[];

  constructor(uri: string | undefined, opts: RequestInit = {}) {
    if (!uri) {
      throw new Error('A remote endpoint is required for a network layer');
    }

    if (typeof uri !== 'string') {
      throw new Error('Remote endpoint must be a string');
    }

    this._uri = uri;
    this._opts = { ...opts };
    this._middlewares = [];
    this._afterwares = [];
  }

  public applyMiddlewares({
    request,
    options,
  }: RequestAndOptions): Promise<RequestAndOptions> {
    return new Promise((resolve, reject) => {
      const queue = (funcs: MiddlewareInterface[], scope: any) => {
        const next = () => {
          if (funcs.length > 0) {
            const f = funcs.shift();
            if (f) {
              f.applyMiddleware.apply(scope, [{ request, options }, next]);
            }
          } else {
            resolve({
              request,
              options,
            });
          }
        };
        next();
      };

      // iterate through middlewares using next callback
      queue([...this._middlewares], this);
    });
  }

  public applyAfterwares({
    response,
    options,
  }: ResponseAndOptions): Promise<ResponseAndOptions> {
    return new Promise((resolve, reject) => {
      // Declare responseObject so that afterware can mutate it.
      const responseObject = { response, options };
      const queue = (funcs: any[], scope: any) => {
        const next = () => {
          if (funcs.length > 0) {
            const f = funcs.shift();
            f.applyAfterware.apply(scope, [responseObject, next]);
          } else {
            resolve(responseObject);
          }
        };
        next();
      };

      // iterate through afterwares using next callback
      queue([...this._afterwares], this);
    });
  }

  public fetchFromRemoteEndpoint({
    request,
    options,
  }: RequestAndOptions): Promise<IResponse> {
    return fetch(this._uri, {
      ...this._opts,
      body: JSON.stringify(printRequest(request)),
      method: 'POST',
      ...options,
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/json',
        ...(options.headers as { [headerName: string]: string }),
      },
    });
  };

  public query(request: Request): Promise<ExecutionResult> {
    const options = { ...this._opts };

    return this.applyMiddlewares({
      request,
      options,
    }).then( (rao) => this.fetchFromRemoteEndpoint.call(this, rao))
      .then(response => this.applyAfterwares({
        response: response as IResponse,
        options,
      }))
      .then(({ response }) => {
        const httpResponse = response as IResponse;

        if (!httpResponse.ok) {
          const httpError = new Error(`Network request failed with status ${response.status} - "${response.statusText}"`);
          (httpError as any).response = httpResponse;

          throw httpError;
        }

        return httpResponse.json();
      })
      .then((payload: ExecutionResult) => {
        if (!payload.hasOwnProperty('data') && !payload.hasOwnProperty('errors')) {
          throw new Error(
            `Server response was missing for query '${request.debugName}'.`,
          );
        } else {
          return payload as ExecutionResult;
        }
      });
  };

  public use(middlewares: MiddlewareInterface[]): HTTPNetworkInterface {
    middlewares.map((middleware) => {
      if (typeof middleware.applyMiddleware === 'function') {
        this._middlewares.push(middleware);
      } else {
        throw new Error('Middleware must implement the applyMiddleware function');
      }
    });
    return this;
  }

  public useAfter(afterwares: AfterwareInterface[]): HTTPNetworkInterface {
    afterwares.map(afterware => {
      if (typeof afterware.applyAfterware === 'function') {
        this._afterwares.push(afterware);
      } else {
        throw new Error('Afterware must implement the applyAfterware function');
      }
    });
    return this;
  }
}

export interface NetworkInterfaceOptions {
  uri?: string;
  opts?: RequestInit;
}

export function createNetworkInterface(
  uriOrInterfaceOpts: string | NetworkInterfaceOptions,
  secondArgOpts: NetworkInterfaceOptions = {},
): HTTPNetworkInterface {
  if (! uriOrInterfaceOpts) {
    throw new Error('You must pass an options argument to createNetworkInterface.');
  }

  let uri: string | undefined;
  let opts: RequestInit | undefined;

  // We want to change the API in the future so that you just pass all of the options as one
  // argument, so even though the internals work with two arguments we're warning here.
  if (typeof uriOrInterfaceOpts === 'string') {
    console.warn(`Passing the URI as the first argument to createNetworkInterface is deprecated \
as of Apollo Client 0.5. Please pass it as the "uri" property of the network interface options.`);
    opts = secondArgOpts;
    uri = uriOrInterfaceOpts;
  } else {
    opts = uriOrInterfaceOpts.opts;
    uri = uriOrInterfaceOpts.uri;
  }
  return new HTTPFetchNetworkInterface(uri, opts);
}
