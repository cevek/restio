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
    [key: string]: (params: any) => ResponseData<Box>;
};
type ReqMapMut = {
    [key: string]: (params: any) => Promise<ResponseData<Box>>;
};

export type ResponseData<T extends Box = Box> = {
    status: number;
    responseValue: T;
    request: RawRequest;
};

let globalMeta!: {name: string; params: unknown; callback: (item: QueryCacheItem) => void};
export type Api<Groups extends Box, Q extends ReqMapQuery, M extends ReqMapMut> = {
    Groups: Groups;
    query: <Filter extends Groups['type']>(
        onCacheDelete: (item: QueryCacheItem) => void,
        filters?: Filter[],
    ) => {
        [P in keyof Q]: (
            params: Q[P] extends () => any ? void : Parameters<Q[P]>[0],
        ) => Extract<ReturnType<Q[P]>['responseValue'], Box<Ok | Filter>>;
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

const Ok = 'Ok';
type Ok = typeof Ok;
const Success = 'Success';
type Success = typeof Success;

type ReqMethods<Groupped extends Box> = {
    post: <T>(url: string, params?: object | null, transform?: () => T) => Promise<ResponseData<Groupped | Box<Ok, T>>>;
    put: <T>(url: string, params?: object | null, transform?: () => T) => Promise<ResponseData<Groupped | Box<Ok, T>>>;
    delete: <T>(
        url: string,
        params?: object | null,
        transform?: () => T,
    ) => Promise<ResponseData<Groupped | Box<Ok, T>>>;
};

const cacheItemToListenersMap = new Map<QueryCacheItem, Set<(item: QueryCacheItem) => void>>();
const listenerToCacheItemMap = new Map<(item: QueryCacheItem) => void, QueryCacheItem>();
const promiseCache = new Map<string, Promise<ResponseData<Box>>>();

type MUtils<BoxedResponse extends Box, Q extends ReqMapQuery> = ReqMethods<BoxedResponse> & {
    cache: Cache<Q>;
};

type ErroredBox = Box<'ConnectionFailed', Error> | Box<'UnacceptableResponse', Error>;
export function createApiFactory() {
    return {
        group<Groups extends Box>(groupToBox: (x: FetchResponseOk) => Groups) {
            return {
                query<Q extends ReqMapQuery>(q: (r: GetQuery<Groups>) => Q) {
                    return {
                        mutation<M extends ReqMapMut>(m: (r: MUtils<Groups, Q>) => M) {
                            const factory = (config: RestApiConfig): Api<Groups, Q, M> => {
                                const {fetcher, queryCache = new Map(), defaultTTL = 600_000} = config;
                                const fetch: <T>(
                                    req: RawRequest,
                                    transform?: (val: unknown) => T,
                                ) => Promise<ResponseData<Groups>> = (req, transform) =>
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
                                            const res = groupToBox(data);

                                            return {
                                                status: data.status,
                                                request: req,
                                                responseValue: cast(
                                                    res.type === Success
                                                        ? box(Ok, transform ? transform(res.value) : res.value)
                                                        : res,
                                                ),
                                            };
                                        });

                                const cache = createCache(queryCache);
                                return {
                                    Groups: cast(null),
                                    cache: cache,
                                    mutation: m({
                                        ...reqMethods(fetch),
                                        cache: cache,
                                    }),
                                    query: cast<any>(
                                        createSuspenses(
                                            q((url, queryParams, transform) =>
                                                query(
                                                    createRawRequest('get', url + queryString(queryParams), null),
                                                    cast(fetch),
                                                    transform,
                                                    queryCache,
                                                    defaultTTL,
                                                ),
                                            ),
                                        ),
                                    ),
                                };
                            };
                            factory.isResponseError = (value: unknown): value is ApiError<Groups | ErroredBox> => {
                                return value instanceof ApiError;
                            };
                            return factory;

                            function createSuspenses(methods: ReqMapQuery) {
                                return (cacheDeleteListener: (item: QueryCacheItem) => void, filters?: string) => {
                                    const suspense = {} as ReturnType<Api<Groups, Q, M>['query']>;
                                    for (const key in methods) {
                                        const k = key as keyof Q;
                                        const doRequest = methods[key];
                                        suspense[k] = cast((params: any) => {
                                            globalMeta = {name: key, params: params, callback: cacheDeleteListener};
                                            const res = doRequest(params);
                                            if (
                                                res.responseValue.type !== Ok &&
                                                (!filters || filters.indexOf(res.responseValue.type) === -1)
                                            ) {
                                                throw new ApiError(res);
                                            }
                                            return res.responseValue;
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
            const val = obj[key];
            arr.push(`${key}=${typeof val === 'boolean' ? 1 : val}`);
        }
        return arr.length > 0 ? '?' + arr.join('&') : '';
    }
    return '';
}

const reqMethods = <Groupped extends Box>(
    fetcher: <T>(req: RawRequest, transform?: (val: unknown) => T) => Promise<ResponseData<Groupped | Box<Ok, T>>>,
): ReqMethods<Groupped> => ({
    put: (url, params, transform) => fetcher(createRawRequest('put', url, params), transform),
    post: (url, params, transform) => fetcher(createRawRequest('post', url, params), transform),
    delete: (url, params, transform) => fetcher(createRawRequest('delete', url, params), transform),
});

function query<T, R extends Box>(
    req: RawRequest,
    fetch: (req: RawRequest) => Promise<ResponseData<R>>,
    transform: ((val: unknown) => T) | undefined,
    queryCache: QueryCache,
    defaultTTL: number,
): ResponseData<R> {
    const {url} = req;
    const ttl = req.ttl === null ? defaultTTL : req.ttl;
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
                val => box('data', val),
                (err: Error) => box('error', err),
            )
            .then(
                res => {
                    if (ttl > 0) {
                        const item: QueryCacheItem = {
                            response:
                                res.type === 'data'
                                    ? {
                                          ...res.value,
                                          responseValue:
                                              res.value.responseValue.type === Success
                                                  ? box(
                                                        Ok,
                                                        transform
                                                            ? transform(res.value.responseValue.value)
                                                            : res.value.responseValue.value,
                                                    )
                                                  : res.value.responseValue,
                                      }
                                    : null,
                            error: res.type === 'error' ? res.value : null,
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

export function createReactApiTools<Config, Groups extends Box, Q extends ReqMapQuery, M extends ReqMapMut>(
    _apiFactory: (config: Config, cache: QueryCache) => Api<Groups, Q, M>,
) {
    const context = React.createContext(cast<Api<Groups, Q, M>>(null));
    return {
        apiContext: context,
        ApiProvider: (props: {api: Api<Groups, Q, M>; children: React.ReactNode}) =>
            React.createElement(context.Provider, {value: props.api, children: props.children}),
        useApi: () => React.useContext(context),
        useQuery: <Filter extends Groups['type'] = never>(filters?: Filter[]) => {
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
            return api.query<Filter>(cb, filters);
        },

        useMutation: <R extends Box, Filter extends Groups['type'] = never>(
            fn: (api: Api<Groups, Q, M>['mutation']) => Promise<ResponseData<R>>,
            onSuccess?: (data: R) => void,
            filters?: Filter[],
        ): [Box<'Empty', void> | Box<'Loading', void> | Extract<R, Box<Ok | Filter>>, () => void] => {
            const [state, setState] = React.useState<
                Box<'Empty', void> | Box<'Loading', void> | Extract<R, Box<Ok | Filter>>
            >(box('Empty', undefined));
            const [err, setErr] = React.useState<Error | null>(null);
            const api = React.useContext(context);
            if (err !== null) {
                throw err;
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
                        res => {
                            if (mounted) {
                                if (
                                    res.responseValue.type !== Ok &&
                                    (!filters || filters.indexOf(cast(res.responseValue.type)) === -1)
                                ) {
                                    setErr(new ApiError(res));
                                } else {
                                    setState(cast(res.responseValue));
                                    if (onSuccess && res.responseValue.type === Ok) {
                                        onSuccess(res.responseValue);
                                    }
                                }
                            }
                        },
                        (err: Error) => (mounted ? setErr(err) : null),
                    );
                },
            ];
        },
    };
}

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

export type GetQuery<Groupped extends Box> = <T>(
    url: string,
    queryParams?: {[key: string]: string | number | boolean},
    transform?: () => T,
) => ResponseData<Groupped | Box<Ok, T>>;
