import * as React from 'react';
type QueryCache = Map<string, QueryCacheItem>;
type QueryCacheItem<R extends Box = Box, Req extends RequestData = RequestData> = {
    response: ResponseData<R> | null;
    error: ApiError | Error | null;
    request: Req;
    requestedAt: string;
    loadingDur: number;
    lastAccess: number;
};

export type FetchResponseOk = {status: number; data: unknown};
export type Fetcher = (req: RawRequest) => Promise<FetchResponse>;
export type FetchResponse =
    | FetchResponseOk
    | {status: 'ConnectionFailed'; data: Error}
    | {status: 'JsonParseError'; data: Error};

type RestApiConfig = {
    queryCache?: QueryCache;
    fetcher: (req: RawRequest) => Promise<FetchResponse>;
    defaultTTL?: number;
};

type ReqMapQuery = {
    [key: string]: (params: any) => Box;
};
type ReqMapMut = {
    [key: string]: (params: any) => Promise<Box>;
};

export type ResponseData<T extends Box = Box> = {
    status: number;
    responseValue: T;
    request: RawRequest;
};

type ResMethods<T extends Box, Res> = {
    ResultType: Res;
    matchers: Matcher<string, string, unknown, unknown>[];
    on<K extends T['type'], R extends Box>(k: K, val: (val: Extract<T, Box<K>>['value']) => R): ResMethods<T, Res | R>;
    onSuccess<R>(): ResMethods<T, Res | Box<'Success', R>>;
    onSuccessTyped<R>(validator: (val: unknown) => R): ResMethods<T, Res | Box<'Success', R>>;
    passthrough<K extends T['type']>(k: K): ResMethods<T, Res | Extract<T, Box<K>>>;
    passthroughTyped<K extends T['type'], R>(k: K, validator: (val: unknown) => R): ResMethods<T, Res | Box<K, R>>;
    passthroughNamed<K extends T['type'], K2 extends string>(
        from: K,
        to: K2,
    ): ResMethods<T, Res | Box<K2, Extract<T, Box<K>>['value']>>;
    passthroughNamedTyped<K extends T['type'], K2 extends string, R>(
        k: K,
        to: K2,
        validator: (val: unknown) => R,
    ): ResMethods<T, Res | Box<K2, R>>;
};

let globalMeta!: {name: string; params: unknown; callback: (item: QueryCacheItem) => void};
export type Api<Q extends ReqMapQuery, M extends ReqMapMut> = {
    query: (
        onCacheDelete: (item: QueryCacheItem) => void,
    ) => {
        [P in keyof Q]: (params: Q[P] extends () => any ? void : Parameters<Q[P]>[0]) => ReturnType<Q[P]>;
    };
    mutation: M;
    cache: Cache<Q>;
};

type Cache<Q extends ReqMapQuery> = {
    clearAll(): void;
    values(): QueryCacheItem[];
    deleteByName<N extends Extract<keyof Q, string>>(
        name: N,
        predicate?: (request: RequestData<N, Parameters<Q[N]>[0]>) => boolean,
    ): void;
    serialize(): object;
};

type Method = 'get' | 'put' | 'delete' | 'post';
export type RequestData<Name extends string = string, Params = unknown> = {
    name: Name;
    params: Params;
    request: RawRequest;
};
export type RawRequest = {
    method: Method;
    url: string;
    body: unknown;
    ttl: number | null;
};

type ReqMethods<R> = {
    get: (url: string, queryParams?: {[key: string]: number | string | boolean} | null) => R;
    post: (url: string, params?: object) => R;
    put: (url: string, params?: object) => R;
    delete: (url: string, params?: object) => R;
};

const cacheItemToListenersMap = new Map<QueryCacheItem, Set<(item: QueryCacheItem) => void>>();
const listenerToCacheItemMap = new Map<(item: QueryCacheItem) => void, QueryCacheItem>();
const promiseCache = new Map<string, Promise<ResponseData<Box>>>();

type QUtils<BoxedResponse extends Box> = ReqMethods<ResponseData<BoxedResponse>>;
type MUtils<BoxedResponse extends Box, Q extends ReqMapQuery> = ReqMethods<Promise<ResponseData<BoxedResponse>>> & {
    cache: Cache<Q>;
};

const Success = 'Success';

type ErroredBox = Box<'ConnectionFailed', Error> | Box<'UnacceptableResponse', Error>;
export function createApiFactory() {
    return {
        group<BoxedResponse extends Box>(groupToBox: (x: FetchResponseOk) => BoxedResponse) {
            return {
                query<Q extends ReqMapQuery>(q: (r: QUtils<BoxedResponse>) => Q) {
                    return {
                        mutation<M extends ReqMapMut>(m: (r: MUtils<BoxedResponse, Q>) => M) {
                            const factory = (config: RestApiConfig): Api<Q, M> => {
                                const {fetcher, queryCache = new Map(), defaultTTL = 600_000} = config;
                                const fetch: (req: RawRequest) => Promise<ResponseData<BoxedResponse>> = req =>
                                    fetcher(req)
                                        .catch<FetchResponse>(err => {
                                            if (err instanceof SyntaxError && err.message.match(/JSON/)) {
                                                return {data: err, status: 'JsonParseError'};
                                            }
                                            return {data: err, status: 'ConnectionFailed'};
                                        })
                                        .then(data => {
                                            if (data.status === 'ConnectionFailed') {
                                                throw new ApiError<ErroredBox>({
                                                    request: req,
                                                    responseValue: box('ConnectionFailed', data.data),
                                                    status: 0,
                                                });
                                            }
                                            if (data.status === 'JsonParseError') {
                                                throw new ApiError<ErroredBox>({
                                                    request: req,
                                                    responseValue: box('UnacceptableResponse', data.data),
                                                    status: 0,
                                                });
                                            }
                                            return {
                                                status: data.status,
                                                request: req,
                                                responseValue: groupToBox(data),
                                            };
                                        });

                                const cache = createCache(queryCache);
                                return {
                                    cache: cache,
                                    mutation: m({
                                        ...reqMethods(fetch),
                                        cache: cache,
                                    }),
                                    query: createSuspenses(
                                        q(reqMethods(req => query(req, fetch, queryCache, defaultTTL))),
                                    ),
                                };
                            };
                            factory.isResponseError = (
                                value: unknown,
                            ): value is ApiError<BoxedResponse | ErroredBox> => {
                                return value instanceof ApiError;
                            };
                            return factory;

                            function createSuspenses(methods: ReqMapQuery) {
                                return (cacheDeleteListener: (item: QueryCacheItem) => void) => {
                                    const suspense = {} as ReturnType<Api<Q, M>['query']>;
                                    for (const key in methods) {
                                        const k = key as keyof Q;
                                        const doRequest = methods[key];
                                        suspense[k] = cast((params: any) => {
                                            globalMeta = {name: key, params: params, callback: cacheDeleteListener};
                                            return doRequest(params);
                                        });
                                    }
                                    return suspense;
                                };
                            }

                            function callCacheDeleteListener(item: QueryCacheItem) {
                                const cacheDeleteSet = cacheItemToListenersMap.get(item);
                                if (cacheDeleteSet !== undefined) {
                                    cacheDeleteSet.forEach(cb => {
                                        listenerToCacheItemMap.delete(cb);
                                        return cb(item);
                                    });
                                }
                            }
                            function createCache(queryCache: QueryCache): Cache<Q> {
                                return {
                                    values: () => [...queryCache.values()],
                                    clearAll: () => {
                                        queryCache.forEach(item => callCacheDeleteListener(item));
                                        return queryCache.clear();
                                    },
                                    deleteByName: (name, predicate) =>
                                        queryCache.forEach((item, key) => {
                                            if (
                                                item.request.name === name &&
                                                (!predicate || predicate(cast(item.request)))
                                            ) {
                                                queryCache.delete(key);
                                                callCacheDeleteListener(item);
                                            }
                                        }),
                                    serialize: () => {
                                        return [...queryCache.entries()].filter(entry => entry[1].error === null);
                                    },
                                };
                            }
                        },
                    };
                },
            };
        },
    };
}

export function deserializeCache(obj: unknown) {
    return new Map<string, QueryCacheItem>(cast(obj));
}

function createRawRequest(
    method: 'get' | 'put' | 'delete' | 'post',
    url: string,
    params: object | null | undefined,
    ttl?: number,
): RawRequest {
    return {
        method: method,
        url: url,
        body: params,
        ttl: ttl === undefined ? null : ttl,
    };
}

function queryString(obj: {[key: string]: number | string | boolean} | null | undefined) {
    if (typeof obj === 'object' && obj !== null) {
        const arr: string[] = [];
        for (const key in obj) {
            arr.push(`key=${obj[key]}`);
        }
        return arr.length > 0 ? '?' + arr.join('&') : '';
    }
    return '';
}

const reqMethods = <R>(fetcher: (req: RawRequest) => R): ReqMethods<R> => ({
    get: (url, params) => fetcher(createRawRequest('get', url + queryString(params), null)),
    put: (url, params) => fetcher(createRawRequest('put', url, params)),
    post: (url, params) => fetcher(createRawRequest('post', url, params)),
    delete: (url, params) => fetcher(createRawRequest('delete', url, params)),
});

const createResMethods = <BoxedResponse extends Box, Res>(
    items: {on: string; handler: (val: unknown) => Box}[] = [],
): ResMethods<BoxedResponse, Res> => {
    return {
        ResultType: cast(null),
        matchers: items,
        on: (k, handler) => createResMethods([...items, {on: k, handler: handler}]),
        onSuccess: () => createResMethods([...items, {on: Success, handler: val => box(Success, val)}]),
        onSuccessTyped: validator =>
            createResMethods([...items, {on: Success, handler: val => box(Success, validator(val))}]),
        passthrough: k => createResMethods([...items, {on: k, handler: val => box(k, val)}]),
        passthroughTyped: (k, validator) =>
            createResMethods([...items, {on: k, handler: val => box(k, validator(val))}]),
        passthroughNamed: (k1, k2) => createResMethods([...items, {on: k1, handler: val => box(k2, val)}]),
        passthroughNamedTyped: (k1, k2, validator) =>
            createResMethods([...items, {on: k1, handler: val => box(k2, validator(val))}]),
    };
};

function query<R extends Box>(
    req: RawRequest,
    fetch: (req: RawRequest) => Promise<ResponseData<R>>,
    queryCache: QueryCache,
    defaultTTL: number,
): ResponseData<R> {
    const {url} = req;
    const ttl = req.ttl ?? defaultTTL;
    const promise = promiseCache.get(url);
    if (promise !== undefined) {
        throw promise;
    }

    let item = queryCache.get(url) as QueryCacheItem<R> | undefined;
    if (item !== undefined) {
        if (new Date(item.requestedAt).getTime() < Date.now() - ttl) {
            queryCache.delete(url);
            item = undefined;
        }
    }
    if (item === undefined) {
        const requestedAt = new Date();
        const promise = fetch(req);
        promiseCache.set(url, promise);
        const res = promise
            .then(
                box => kind('data', box),
                (err: Error) => kind('error', err),
            )
            .then(
                res => {
                    if (ttl > 0) {
                        const item: QueryCacheItem = {
                            response: res.kind === 'data' ? res.value : null,
                            error: res.kind === 'error' ? res.value : null,
                            request: {request: req, name: globalMeta.name, params: globalMeta.params},
                            lastAccess: Date.now() - requestedAt.getTime(),
                            loadingDur: Date.now() - requestedAt.getTime(),
                            requestedAt: requestedAt.toISOString(),
                        };
                        let callbackSet = cacheItemToListenersMap.get(item);
                        if (callbackSet === undefined) {
                            callbackSet = new Set();
                            cacheItemToListenersMap.set(item, callbackSet);
                        }
                        listenerToCacheItemMap.set(globalMeta.callback, item);
                        callbackSet.add(globalMeta.callback);
                        queryCache.set(url, item);
                    }
                    promiseCache.delete(url);
                },
                err => console.error('Unexpected error', err),
            );
        throw res;
    }
    item.lastAccess = Date.now() - new Date(item.requestedAt).getTime();
    if (item.error !== null) {
        throw item.error;
    }
    if (item.response !== null) {
        return item.response;
    }
    throw new Error('never');
}

function kind<Kind extends string, T>(kind: Kind, value: T) {
    return {kind: kind, value: value};
}

export function createReactApiTools<Config, Q extends ReqMapQuery, M extends ReqMapMut>(
    _apiFactory: (config: Config, cache: QueryCache) => Api<Q, M>,
) {
    const context = React.createContext(cast<Api<Q, M>>(null));
    return {
        apiContext: context,
        ApiProvider: (props: {api: Api<Q, M>; children: React.ReactNode}) =>
            React.createElement(context.Provider, {value: props.api, children: props.children}),
        useApi: () => React.useContext(context),
        useSuspense: () => {
            const [, setState] = React.useState(null);
            const cb: (item: QueryCacheItem) => void = cast(setState);
            React.useEffect(
                () => () => {
                    const cacheItem = listenerToCacheItemMap.get(cb);
                    if (cacheItem !== undefined) {
                        const set = cacheItemToListenersMap.get(cacheItem);
                        if (set !== undefined) {
                            set.delete(cb);
                        }
                    }
                    listenerToCacheItemMap.delete(cb);
                },
                [],
            );
            const api = React.useContext(context);
            return api.query(cb);
        },
        useMutation: <R extends Box<N, unknown>, N extends string>(
            fn: (mut: Api<Q, M>['mutation']) => Promise<R>,
        ): [R | Box<'Empty', void> | Box<'Loading', void>, () => void] => {
            const [state, setState] = React.useState<
                Box<'Empty', void> | Box<'Loading', void> | Box<'Error', Error> | R
            >(box('Empty', undefined));
            const api = React.useContext(context);
            if (state.type === 'Error') {
                throw state.value;
            }
            let mounted = true;
            React.useEffect(
                () => () => {
                    mounted = false;
                },
                [],
            );
            return [
                cast(state),
                () => {
                    const promise = fn(api.mutation);
                    setState(box('Loading', undefined));
                    promise.then(
                        res => (mounted ? setState(res) : null),
                        (err: Error) => (mounted ? setState(box('Error', err)) : null),
                    );
                },
            ];
        },
    };
}

type Matcher<FromK extends string, ToK extends string, FromT, ToT> = {
    on: FromK;
    handler: (res: FromT) => Box<ToK, ToT>;
};

export type Box<K extends string = string, V = unknown> = {type: K; value: V};
export function box<K extends string, V>(type: K, value: V): Box<K, V> {
    return {type: type, value: value};
}

export function isBox<B extends Box>(box: unknown): box is B {
    return (
        typeof box === 'object' &&
        box !== null &&
        box.constructor === Object &&
        typeof (box as Box).type === 'string' &&
        ('value' as keyof Box) in box
    );
}

export function fakeFetchFactory(config: {
    handler: (
        req: RawRequest,
        res: <T>(status: FetchResponse['status'], data: T) => FetchResponse,
    ) => FetchResponse | void;
    wait?: number;
}) {
    const {handler, wait = 500} = config;
    return (req: RawRequest) => {
        const res = handler(req, (status, data) => cast({status: status, data: data}));
        if (res === undefined) {
            throw new Error('FakeFetch: unhandled url: ' + req.url);
        }
        return sleep(wait).then(() => res);
    };
}
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export class ApiError<T extends Box = Box> extends Error {
    constructor(public response: ResponseData<T>) {
        super('ApiError: ' + response.responseValue.type);
    }
}

function cast<T>(val: unknown) {
    return val as T;
}
