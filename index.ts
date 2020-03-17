import * as React from 'react';
export type QueryCache = Map<string, QueryCacheItem>;
export type ResponseDataValue = unknown; //{__brand: 'ReqResponse'};
export type QueryCacheItem<Req extends RequestData<unknown> = RequestData, Name = string> = {
    name: Name;
    response: Group | null;
    error: RestApiError | Error | null;
    request: Req;
    requestedAt: string;
    loadingDur: number;
    lastAccess: number;
};

type FetchResponse =
    | {status: number; data: ResponseDataValue}
    | {status: 'Failed'; data: Error}
    | {status: 'JsonParseError'; data: Error};

type RestApiConfig = {
    queryCache?: QueryCache;
    fetch: (req: RequestData) => Promise<FetchResponse>;
    defaultTTL?: number;
};

type Context = {
    queryCache: QueryCache;
    fetch: (req: RequestData) => Promise<{originalResponse: ResponseData; group: Group}>;
    defaultTTL: number;
};

type ReqMapQuery = {
    [key: string]: {
        request: (params?: any) => RequestData;
        response: ResMethods<any, any>;
    };
};
type ReqMapMut = {
    [key: string]: {
        request: (params?: any) => RequestData;
        response: ResMethods<any, any>;
        effectOnSuccess?: () => void;
    };
};

export type ResponseData<T = ResponseDataValue> = {
    status: number;
    responseValue: T;
    request: RequestData;
};

type ResMethods<T extends Group, Res> = {
    _: Res;
    matchers: Matcher<string, string, unknown, unknown>[];
    on<K extends T['group'], R extends Group>(
        k: K,
        val: (val: Extract<T, Group<K>>['value']) => R,
    ): ResMethods<T, Res | R>;
    onSuccess<R>(): ResMethods<T, Res | Group<'success', R>>;
    onSuccessTyped<R>(validator: (val: unknown) => R): ResMethods<T, Res | Group<'success', R>>;
    proxy<K extends T['group']>(k: K): ResMethods<T, Res | Extract<T, Group<K>>>;
    proxyTyped<K extends T['group'], R>(k: K, validator: (val: unknown) => R): ResMethods<T, Res | Group<K, R>>;
    proxyAs<K extends T['group'], K2 extends string>(
        from: K,
        to: K2,
    ): ResMethods<T, Res | Group<K2, Extract<T, Group<K>>['value']>>;
    proxyAsTyped<K extends T['group'], K2 extends string, R>(
        k: K,
        to: K2,
        validator: (val: unknown) => R,
    ): ResMethods<T, Res | Group<K2, R>>;
};

export type Api<Q extends ReqMapQuery, M extends ReqMapQuery> = {
    suspense: (
        onCacheDelete: (item: QueryCacheItem) => void,
    ) => {
        [P in keyof Q]: (
            params: Q[P]['request'] extends () => any ? void : Parameters<Q[P]['request']>[0],
        ) => Q[P]['response']['_'];
    };
    query: {
        [P in keyof Q]: (
            params: Q[P]['request'] extends () => any ? void : Parameters<Q[P]['request']>[0],
        ) => Promise<Q[P]['response']['_']>;
    };
    mutation: {
        [P in keyof M]: (
            params: M[P]['request'] extends () => any ? void : Parameters<M[P]['request']>[0],
        ) => Promise<M[P]['response']['_']>;
    };
    cache: Cache<Q>;
};

type Cache<Q extends ReqMapQuery> = {
    clearAll(): void;
    values(): QueryCacheItem[];
    deleteBy(
        predicate: (
            params: {
                [P in keyof Q]: QueryCacheItem<ReturnType<Q[P]['response']['_']>, P>;
            }[keyof Q],
        ) => boolean,
    ): void;
    deleteByName(name: keyof Q): void;
    serialize(): object;
};

type Method = 'get' | 'put' | 'delete' | 'post';
export type RequestData<Meta = unknown> = {
    method: Method;
    url: string;
    json: object | null;
    meta: Meta;
    ttl: number | null;
};

type ReqMethods = {
    get: <Meta>(url: string, other?: Other<Meta>) => RequestData<Meta>;
    post: <Meta>(url: string, params: object | null, other?: Other<Meta>) => RequestData<Meta>;
    put: <Meta>(url: string, params: object | null, other?: Other<Meta>) => RequestData<Meta>;
    delete: <Meta>(url: string, params: object | null, other?: Other<Meta>) => RequestData<Meta>;
};

const cacheItemToListenersMap = new Map<QueryCacheItem, Set<(item: QueryCacheItem) => void>>();
const listenerToCacheItemMap = new Map<(item: QueryCacheItem) => void, QueryCacheItem>();
const promiseCache = new Map<string, Promise<{originalResponse: ResponseData; group: Group}>>();

type QUtils<G extends Group> = ReqMethods & ResMethods<G, never> & {shape: <T>() => (val: unknown) => T};
type MUtils<G extends Group, Q extends ReqMapQuery> = QUtils<G> & {cache: Cache<Q>};

export type DefaultGroups = Group<'failed', Error> | Group<'unacceptableResponse', Error>;
export function createRestApiFactory() {
    return {
        group<GroupStatus extends Group>(groupStatus: (x: ResponseData) => GroupStatus) {
            return {
                query<Q extends ReqMapQuery>(q: (r: QUtils<GroupStatus>) => Q) {
                    return {
                        mutation<M extends ReqMapMut>(m: (r: MUtils<GroupStatus, Q>) => M) {
                            const factory = (config: RestApiConfig): Api<Q, M> => {
                                const {fetch: f, queryCache = new Map(), defaultTTL = 600_000} = config;
                                const fetch: Context['fetch'] = (req: RequestData) =>
                                    f(req).then(data => {
                                        if (data.status === 'Failed') {
                                            throw new RestApiError(
                                                {request: req, responseValue: cast(null), status: 0},
                                                group('failed', data.data),
                                            );
                                        }
                                        if (data.status === 'JsonParseError') {
                                            throw new RestApiError(
                                                {request: req, responseValue: cast(null), status: 0},
                                                group('unacceptableResponse', data.data),
                                            );
                                        }
                                        const response: ResponseData = {
                                            status: data.status,
                                            request: req,
                                            responseValue: data.data,
                                        };
                                        return {
                                            originalResponse: response,
                                            group: groupStatus(response),
                                        };
                                    });
                                const context: Context = {fetch, queryCache, defaultTTL};
                                const cache = createCache(queryCache);
                                const utils: MUtils<GroupStatus, Q> = {
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
                            ): value is RestApiError<GroupStatus | DefaultGroups> => {
                                return value instanceof RestApiError;
                            };
                            return factory;

                            function createQueries(methods: ReqMapQuery, context: Context) {
                                const queries = {} as Api<Q, M>['query'];
                                for (const key in methods) {
                                    const k = key as keyof Q;
                                    const createRequest = methods[key].request;
                                    const matchers = methods[key].response.matchers;
                                    queries[k] = params => {
                                        const req = createRequest(params);
                                        const res = query(key, req, context, matchers);
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
                                        const createRequest = methods[key].request;
                                        const matchers = methods[key].response.matchers;
                                        suspense[k] = params => {
                                            const req = createRequest(params);
                                            const res = query(key, req, context, matchers);
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
                                    const createRequest = methods[key].request;
                                    const effect = methods[key].effectOnSuccess;
                                    const matchers = methods[key].response.matchers;
                                    mutation[k] = params => {
                                        const req = createRequest(params);
                                        return context.fetch(req).then(({group, originalResponse}) => {
                                            const handler = matchers.find(m => m.on === group.group);
                                            if (handler !== undefined) {
                                                const result = handler.handler(group.value);
                                                if (group.group === 'success' && effect !== undefined) {
                                                    effect();
                                                }
                                                return result;
                                            }
                                            throw new RestApiError(originalResponse, group);
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
                                    deleteBy: predicate =>
                                        queryCache.forEach((item, key) => {
                                            if (predicate(cast(item))) {
                                                queryCache.delete(key);
                                                callCacheDeleteListener(item);
                                            }
                                        }),
                                    deleteByName: name =>
                                        queryCache.forEach((item, key) => {
                                            if (item.name === name) {
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

type Other<Meta> = {meta?: Meta; ttl?: number};
export function createRequest<Meta>(
    method: 'get' | 'put' | 'delete' | 'post',
    url: string,
    params: object | null,
    other?: Other<Meta>,
): RequestData<Meta> {
    return {
        method: method,
        url: url,
        json: params,
        meta: cast(other === undefined ? null : other.meta),
        ttl: other !== undefined && other.ttl !== undefined ? other.ttl : null,
    };
}

const reqMethods: ReqMethods = {
    get: <Meta>(url: string, other?: Other<Meta>) => createRequest('get', url, null, other),
    put: <Meta>(url: string, params: object | null, other?: Other<Meta>) => createRequest('put', url, params, other),
    post: <Meta>(url: string, params: object | null, other?: Other<Meta>) => createRequest('post', url, params, other),
    delete: <Meta>(url: string, params: object | null, other?: Other<Meta>) =>
        createRequest('delete', url, params, other),
};

const createResMethods = <G extends Group, Res>(
    items: {on: string; handler: (val: unknown) => Group}[] = [],
): ResMethods<G, Res> => {
    return {
        _: cast(null),
        matchers: items,
        on: (k, handler) => createResMethods([...items, {on: k, handler: handler}]),
        onSuccess: () => createResMethods([...items, {on: 'success', handler: val => group('success', val)}]),
        onSuccessTyped: validator =>
            createResMethods([...items, {on: 'success', handler: val => group('success', validator(val))}]),
        proxy: k => createResMethods([...items, {on: k, handler: val => group(k, val)}]),
        proxyTyped: (k, validator) => createResMethods([...items, {on: k, handler: val => group(k, validator(val))}]),
        proxyAs: (k1, k2) => createResMethods([...items, {on: k1, handler: val => group(k2, val)}]),
        proxyAsTyped: (k1, k2, validator) =>
            createResMethods([...items, {on: k1, handler: val => group(k2, validator(val))}]),
    };
};

function query(
    name: string,
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
                ({group, originalResponse}) => {
                    const handler = matchers.find(m => m.on === group.group);
                    if (handler === undefined) {
                        return kind('error', new RestApiError(originalResponse, group));
                    }
                    return kind('data', handler.handler(group.value));
                },
                (err: Error) => kind('error', err),
            )
            .then(
                res => {
                    if (ttl > 0) {
                        const item: QueryCacheItem = {
                            name: name,
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

export function createReactRestApi<Config, Q extends ReqMapQuery, M extends ReqMapQuery>(
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
        useMutation: <R extends Group<N, unknown>, N extends string>(
            fn: (mut: Api<Q, M>['mutation']) => Promise<R>,
        ): [R | Group<'Empty', void> | Group<'Loading', void>, () => void] => {
            const [state, setState] = React.useState<
                Group<'Empty', void> | Group<'Loading', void> | Group<'Error', Error> | R
            >(group('Empty', undefined));
            const api = React.useContext(context);
            if (state.group === 'Error') {
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
                    setState(group('Loading', undefined));
                    promise.then(
                        res => (mounted ? setState(res) : null),
                        (err: Error) => (mounted ? setState(group('Error', err)) : null),
                    );
                },
            ];
        },
    };
}

export type Matcher<FromK extends string, ToK extends string, FromT, ToT> = {
    on: FromK;
    handler: (res: FromT) => Group<ToK, ToT>;
};

export type Group<K extends string = string, V = unknown> = {group: K; value: V};
export function group<K extends string, V>(group: K, value: V): Group<K, V> {
    return {group: group, value: value};
}

export function isGroup<G extends Group>(group: unknown): group is G {
    return (
        typeof group === 'object' &&
        group !== null &&
        group.constructor === Object &&
        typeof (group as Group).group === 'string' &&
        'value' in group
    );
}

export function shape<T>() {
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

export class RestApiError<T extends Group = Group> {
    constructor(public response: ResponseData | null, public group: T, public kind = group.group) {}
}

function cast<T>(val: unknown) {
    return val as T;
}
