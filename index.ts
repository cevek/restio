import * as React from 'react';
type QueryCache = Map<string, QueryCacheItem>;
type QueryCacheItem<Req extends RequestData = RequestData> = {
    response: Box | null;
    error: ApiError | Error | null;
    request: Req;
    requestedAt: string;
    loadingDur: number;
    lastAccess: number;
};

export type FetchResponse =
    | {status: number; data: unknown}
    | {status: 'ConnectionFailed'; data: Error}
    | {status: 'JsonParseError'; data: Error};

type RestApiConfig = {
    queryCache?: QueryCache;
    fetcher: (req: RequestData) => Promise<FetchResponse>;
    defaultTTL?: number;
};

type Context = {
    queryCache: QueryCache;
    fetch: (req: RequestData) => Promise<FetcherResult>;
    defaultTTL: number;
};

type ReqMapQuery = {
    [key: string]: {
        request: (params?: any) => RawRequest;
        response: ResMethods<any, any>;
    };
};
type ReqMapMut = {
    [key: string]: {
        request: (params?: any) => RawRequest;
        response: ResMethods<any, any>;
        effectOnSuccess?: () => void;
    };
};

export type ResponseData<T = unknown> = {
    status: number;
    responseValue: T;
    request: RequestData;
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

export type Api<Q extends ReqMapQuery, M extends ReqMapQuery> = {
    suspense: (
        onCacheDelete: (item: QueryCacheItem) => void,
    ) => {
        [P in keyof Q]: (
            params: Q[P]['request'] extends () => any ? void : Parameters<Q[P]['request']>[0],
        ) => Q[P]['response']['ResultType'];
    };
    query: {
        [P in keyof Q]: (
            params: Q[P]['request'] extends () => any ? void : Parameters<Q[P]['request']>[0],
        ) => Promise<Q[P]['response']['ResultType']>;
    };
    mutation: {
        [P in keyof M]: (
            params: M[P]['request'] extends () => any ? void : Parameters<M[P]['request']>[0],
        ) => Promise<M[P]['response']['ResultType']>;
    };
    cache: Cache<Q>;
};

type Cache<Q extends ReqMapQuery> = {
    clearAll(): void;
    values(): QueryCacheItem[];
    deleteByName<N extends Extract<keyof Q, string>>(
        name: N,
        predicate?: (request: RequestData<N, Parameters<Q[N]['request']>[0]>) => boolean,
    ): void;
    serialize(): object;
};

type Method = 'get' | 'put' | 'delete' | 'post';
export type RequestData<Name extends string = string, Params = unknown> = {
    name: Name;
    method: Method;
    url: string;
    body: unknown;
    params: Params;
    ttl: number | null;
};
type RawRequest = {
    method: Method;
    url: string;
    body: unknown;
    ttl: number | null;
};

type ReqMethods = {
    get: (
        url: string,
        queryParams?: {[key: string]: number | string | boolean} | null,
        other?: OtherParams,
    ) => RawRequest;
    post: (url: string, params: object | null, other?: OtherParams) => RawRequest;
    put: (url: string, params: object | null, other?: OtherParams) => RawRequest;
    delete: (url: string, params: object | null, other?: OtherParams) => RawRequest;
};

type FetcherResult = {originalResponse: ResponseData; box: Box};
const cacheItemToListenersMap = new Map<QueryCacheItem, Set<(item: QueryCacheItem) => void>>();
const listenerToCacheItemMap = new Map<(item: QueryCacheItem) => void, QueryCacheItem>();
const promiseCache = new Map<string, Promise<FetcherResult>>();

type QUtils<BoxedResponse extends Box> = ReqMethods &
    ResMethods<BoxedResponse, never> & {shape: <T>() => (val: unknown) => T};
type MUtils<BoxedResponse extends Box, Q extends ReqMapQuery> = QUtils<BoxedResponse> & {cache: Cache<Q>};

const Success = 'Success';

type ErroredBox = Box<'ConnectionFailed', Error> | Box<'UnacceptableResponse', Error>;
export function createApiFactory() {
    return {
        group<BoxedResponse extends Box>(groupToBox: (x: ResponseData) => BoxedResponse) {
            return {
                query<Q extends ReqMapQuery>(q: (r: QUtils<BoxedResponse>) => Q) {
                    return {
                        mutation<M extends ReqMapMut>(m: (r: MUtils<BoxedResponse, Q>) => M) {
                            const factory = (config: RestApiConfig): Api<Q, M> => {
                                const {fetcher, queryCache = new Map(), defaultTTL = 600_000} = config;
                                const fetch: Context['fetch'] = (req: RequestData) =>
                                    fetcher(req).then(
                                        (data): FetcherResult => {
                                            if (data.status === 'ConnectionFailed') {
                                                throw new ApiError<ErroredBox>(
                                                    {request: req, responseValue: cast(null), status: 0},
                                                    box('ConnectionFailed', data.data),
                                                );
                                            }
                                            if (data.status === 'JsonParseError') {
                                                throw new ApiError<ErroredBox>(
                                                    {request: req, responseValue: cast(null), status: 0},
                                                    box('UnacceptableResponse', data.data),
                                                );
                                            }
                                            const response: ResponseData = {
                                                status: data.status,
                                                request: req,
                                                responseValue: data.data,
                                            };
                                            return {
                                                originalResponse: response,
                                                box: groupToBox(response),
                                            };
                                        },
                                    );
                                const context: Context = {fetch, queryCache, defaultTTL};
                                const cache = createCache(queryCache);
                                const utils: MUtils<BoxedResponse, Q> = {
                                    ...reqMethods,
                                    ...createResMethods(),
                                    shape: shape,
                                    cache: cache,
                                };
                                return {
                                    cache: cache,
                                    mutation: createMutations(m(utils), context),
                                    query: createQueries(q(utils), context),
                                    suspense: createSuspenses(q(utils), context),
                                };
                            };
                            factory.isResponseError = (
                                value: unknown,
                            ): value is ApiError<BoxedResponse | ErroredBox> => {
                                return value instanceof ApiError;
                            };
                            return factory;

                            function createQueries(methods: ReqMapQuery, context: Context) {
                                const queries = {} as Api<Q, M>['query'];
                                for (const key in methods) {
                                    const k = key as keyof Q;
                                    const getRawRequest = methods[key].request;
                                    const matchers = methods[key].response.matchers;
                                    queries[k] = params => {
                                        const req = createRequest(getRawRequest(params), key, params);
                                        const res = query(req, context, matchers);
                                        if (res.kind === 'error') {
                                            return Promise.reject(res.value);
                                        }
                                        if (res.kind === 'promise') {
                                            return res.value;
                                        }
                                        return Promise.resolve(res.value);
                                    };
                                }
                                return queries;
                            }

                            function createSuspenses(methods: ReqMapQuery, context: Context) {
                                return (cacheDeleteListener: (item: QueryCacheItem) => void) => {
                                    const suspense = {} as ReturnType<Api<Q, M>['suspense']>;
                                    for (const key in methods) {
                                        const k = key as keyof Q;
                                        const getRawRequest = methods[key].request;
                                        const matchers = methods[key].response.matchers;
                                        suspense[k] = params => {
                                            const req = createRequest(getRawRequest(params), key, params);
                                            const res = query(req, context, matchers);
                                            if (res.kind === 'error' || res.kind === 'promise') {
                                                throw res.value;
                                            }
                                            let callbackSet = cacheItemToListenersMap.get(res.value);
                                            if (callbackSet === undefined) {
                                                callbackSet = new Set();
                                                cacheItemToListenersMap.set(res.value, callbackSet);
                                            }
                                            listenerToCacheItemMap.set(cacheDeleteListener, res.value);
                                            callbackSet.add(cacheDeleteListener);
                                            return res.value.response;
                                        };
                                    }
                                    return suspense;
                                };
                            }

                            function createMutations(methods: ReqMapMut, context: Context) {
                                const mutation = {} as Api<Q, M>['mutation'];
                                for (const key in methods) {
                                    const k = key as keyof M;
                                    const getRawRequest = methods[key].request;
                                    const effect = methods[key].effectOnSuccess;
                                    const matchers = methods[key].response.matchers;
                                    mutation[k] = params => {
                                        const req = createRequest(getRawRequest(params), key, params);
                                        return context.fetch(req).then(({box, originalResponse}) => {
                                            const handler = matchers.find(m => m.on === box.type);
                                            if (handler !== undefined) {
                                                const result = handler.handler(box.value);
                                                if (box.type === Success && effect !== undefined) {
                                                    effect();
                                                }
                                                return result;
                                            }
                                            throw new ApiError(originalResponse, box);
                                        });
                                    };
                                }
                                return mutation;
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

type OtherParams = {ttl?: number};
function createRawRequest(
    method: 'get' | 'put' | 'delete' | 'post',
    url: string,
    params: object | null | undefined,
    other?: OtherParams,
): RawRequest {
    return {
        method: method,
        url: url,
        body: params,
        ttl: other !== undefined && other.ttl !== undefined ? other.ttl : null,
    };
}

function createRequest<Name extends string, Params>(
    req: RawRequest,
    name: Name,
    params: Params,
): RequestData<Name, Params> {
    return {
        body: req.body,
        method: req.method,
        name: name,
        params: params,
        ttl: req.ttl,
        url: req.url,
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

const reqMethods: ReqMethods = {
    get: (url, params, other) => createRawRequest('get', url + queryString(params), null, other),
    put: (url, params, other) => createRawRequest('put', url, params, other),
    post: (url, params, other) => createRawRequest('post', url, params, other),
    delete: (url, params, other) => createRawRequest('delete', url, params, other),
};

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

function query(
    req: RequestData,
    {fetch, queryCache, defaultTTL}: Context,
    matchers: Matcher<string, string, unknown, unknown>[],
) {
    const ttl = req.ttl === null ? defaultTTL : req.ttl;
    const promise = promiseCache.get(req.url);
    if (promise !== undefined) {
        return kind('promise', promise);
    }

    let item = queryCache.get(req.url);
    if (item !== undefined) {
        if (new Date(item.requestedAt).getTime() < Date.now() - ttl) {
            queryCache.delete(req.url);
            item = undefined;
        }
    }
    if (item === undefined) {
        const requestedAt = new Date();
        const promise = fetch(req);
        promiseCache.set(req.url, promise);
        const res = promise
            .then(
                ({box, originalResponse}) => {
                    const handler = matchers.find(m => m.on === box.type);
                    if (handler === undefined) {
                        return kind('error', new ApiError(originalResponse, box));
                    }
                    return kind('data', handler.handler(box.value));
                },
                (err: Error) => kind('error', err),
            )
            .then(
                res => {
                    if (ttl > 0) {
                        const item: QueryCacheItem = {
                            response: res.kind === 'data' ? res.value : null,
                            error: res.kind === 'error' ? res.value : null,
                            request: req,
                            lastAccess: Date.now() - requestedAt.getTime(),
                            loadingDur: Date.now() - requestedAt.getTime(),
                            requestedAt: requestedAt.toISOString(),
                        };
                        queryCache.set(req.url, item);
                    }
                    promiseCache.delete(req.url);
                },
                err => console.error('Unexpected error', err),
            );
        return kind('promise', res);
    }
    item.lastAccess = Date.now() - new Date(item.requestedAt).getTime();
    if (item.error !== null) {
        return kind('error', item.error);
    }
    return kind('data', item);
}

function kind<Kind extends string, T>(kind: Kind, value: T) {
    return {kind: kind, value: value};
}

export function createReactApiTools<Config, Q extends ReqMapQuery, M extends ReqMapQuery>(
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
            return api.suspense(cb);
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

function shape<T>() {
    return (val: unknown) => val as T;
}

export function fakeFetchFactory(config: {
    handler: (
        method: Method,
        url: string,
        params: unknown,
        res: <T>(status: FetchResponse['status'], data: T) => FetchResponse,
    ) => FetchResponse | void;
    wait?: number;
}) {
    const {handler, wait = 500} = config;
    return (method: Method, url: string, params: unknown) => {
        const res = handler(method, url, params, (status, data) => cast({status: status, data: data}));
        if (res === undefined) {
            throw new Error('FakeFetch: unhandled url: ' + url);
        }
        return sleep(wait).then(() => res);
    };
}
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export class ApiError<T extends Box = Box> {
    constructor(public response: ResponseData | null, public box: T, public kind = box.type) {}
}

function cast<T>(val: unknown) {
    return val as T;
}
