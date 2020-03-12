import * as React from 'react';
import {cast, assert, assertFn} from 'assertio';
export type QueryCache = Map<string, QueryCacheItem>;
export type QueryCacheItem<Req extends RequestData<unknown, string, unknown> = RequestData> = {
    data: unknown;
    error: Error | null;
    request: Req;
    requestedAt: string;
    loadingDur: number;
    lastAccess: number;
};
const promiseCache = new Map<string, Promise<unknown>>();
export function createRestApiFactory<
    Config,
    T extends {
        query: {[key: string]: (params: any) => RequestData};
        mutation: {[key: string]: (params: any) => RequestData};
    }
>(
    params: (
        config: Config,
    ) => {
        fetch: (req: RequestData) => Promise<unknown>;
        defaultTTL?: number;
    },
    methods: T,
): (config: Config, cache: QueryCache) => Api<T> {
    return (config, queryCache) => {
        const {fetch, defaultTTL} = params(config);
        const res: Api<T> = {
            cache: {
                clearAll: () => queryCache.clear(),
                clearBy: predicate =>
                    queryCache.forEach((item, key) => {
                        if (predicate(cast(item))) {
                            queryCache.delete(key);
                        }
                    }),
                serialize: () => {
                    return [...queryCache.entries()].filter(entry => entry[1].error === null);
                },
            },
            mutation: {} as Api<T>['mutation'],
            query: {} as Api<T>['query'],
            suspense: {} as Api<T>['suspense'],
        };
        function checkReq(req: RequestData, key: string) {
            assert(req.name === key, err);
            return req;
        }
        for (const key in methods.query) {
            const k = key as keyof T['query'];
            const createRequest = methods.query[key];
            res.query[k] = params => {
                const req = checkReq(createRequest(params), key);
                const res = query(req, fetch, queryCache, defaultTTL);
                if (res.kind === 'error') {
                    return Promise.reject(res.data);
                }
                if (res.kind === 'promise') {
                    return res.data;
                }
                return Promise.resolve(res.data);
            };
            res.suspense[k] = params => {
                const req = checkReq(createRequest(params), key);
                const res = query(req, fetch, queryCache, defaultTTL);
                if (res.kind === 'error' || res.kind === 'promise') {
                    throw res.data;
                }
                return res.data;
            };
        }
        for (const key in methods.mutation) {
            const k = key as keyof T['mutation'];
            const createRequest = methods.mutation[key];
            res.mutation[k] = params => {
                const req = checkReq(createRequest(params), key);
                const validator = getValidator(req);
                return fetch(req).then(data => {
                    validator?.(data);
                    return data;
                });
            };
        }
        return res;
    };
}

const err = 'Request name should be same as key in query object';

export type Api<
    T extends {
        query: {[key: string]: (params: any) => RequestData};
        mutation: {[key: string]: (params: any) => RequestData};
    }
> = {
    suspense: {
        [P in keyof T['query']]: (
            ...params: Parameters<T['query'][P]>
        ) => ReturnType<T['query'][P]>['responseType']['type'];
    };
    query: {
        [P in keyof T['query']]: (
            ...params: Parameters<T['query'][P]>
        ) => Promise<ReturnType<T['query'][P]>['responseType']['type']>;
    };
    mutation: {
        [P in keyof T['mutation']]: (
            ...params: Parameters<T['mutation'][P]>
        ) => Promise<ReturnType<T['mutation'][P]>['responseType']['type']>;
    };
    cache: {
        clearAll(): void;
        clearBy(predicate: (params: QueryCacheItem<ReturnType<T['query'][keyof T['query']]>>) => boolean): void;
        // clearBy(
        //     predicate: (
        //         params: QueryCacheItem<
        //             {
        //                 [P in keyof T['query']]: ReturnType<T['query'][P]> extends RequestData<infer X, any, infer Meta>
        //                     ? RequestData<X, P, Meta>
        //                     : never;
        //             }[keyof T['query']]
        //         >,
        //     ) => boolean,
        // ): void;
        serialize(): object;
    };
};

export type RequestData<T = unknown, Name extends string = string, Meta = unknown> = {
    name: Name;
    method: string;
    url: string;
    json: object | null;
    responseType: {
        id: string;
        type: T;
    };
    meta: Meta;
    ttl: number | undefined;
};

const map = new Map<string, (val: any) => void>();
export function createRequest<Name extends string, T, Meta>(
    method: string,
    name: Name,
    url: string,
    params: object | null,
    validator: (val: T) => void,
    other?: Other<Meta>,
): RequestData<T, Name, Meta> {
    const id = validator.name;
    assert(id !== '', 'Validator name is empty');
    assertFn(() => {
        const existsValidator = map.get(id);
        return !existsValidator || existsValidator === validator;
    }, `Validator with name ${id} already exists`);
    map.set(id, validator);
    return {
        name: name,
        method: method,
        responseType: {
            id: id,
            type: cast(null),
        },
        url: url,
        json: params,
        meta: cast(other?.meta),
        ttl: other?.ttl,
    };
}

type Other<Meta> = {meta?: Meta; ttl?: number};
export const r = {
    get: <Name extends string, T, Meta>(name: Name, url: string, validator: (val: T) => void, other?: Other<Meta>) =>
        createRequest('get', name, url, null, validator, other),
    put: <Name extends string, T, Meta>(
        name: Name,
        url: string,
        params: {} | null,
        validator: (val: T) => void,
        other?: Other<Meta>,
    ) => createRequest('put', name, url, params, validator, other),
    post: <Name extends string, T, Meta>(
        name: Name,
        url: string,
        params: {} | null,
        validator: (val: T) => void,
        other?: Other<Meta>,
    ) => createRequest('post', name, url, params, validator, other),
    delete: <Name extends string, T, Meta>(
        name: Name,
        url: string,
        params: {} | null,
        validator: (val: T) => void,
        other?: Other<Meta>,
    ) => createRequest('delete', name, url, params, validator, other),
};

export function deserializeCache(obj: unknown) {
    return new Map<string, QueryCacheItem>(cast(obj));
}

export function query(
    req: RequestData,
    fetcher: (req: RequestData) => Promise<unknown>,
    cache: QueryCache,
    defaultTTL: number | undefined,
): {kind: 'error'; data: Error} | {kind: 'promise'; data: Promise<unknown>} | {kind: 'data'; data: unknown} {
    const ttl = req.ttl ?? defaultTTL ?? 600;
    const promise = promiseCache.get(req.url);
    if (promise !== undefined) {
        return {kind: 'promise', data: promise};
    }
    let item = cache.get(req.url);
    if (item !== undefined) {
        if (new Date(item.requestedAt).getTime() < Date.now() - ttl) {
            cache.delete(req.url);
            item = undefined;
        }
    }
    const requestedAt = new Date();
    if (item === undefined) {
        const promise = fetcher(req);
        promiseCache.set(req.url, promise);
        if (ttl > 0) {
            promise.then(
                data => {
                    const validator = getValidator(req);
                    validator?.(data);
                    const item: QueryCacheItem = {
                        data: data,
                        error: null,
                        request: req,
                        lastAccess: Date.now() - requestedAt.getTime(),
                        loadingDur: Date.now() - requestedAt.getTime(),
                        requestedAt: requestedAt.toISOString(),
                    };
                    cache.set(req.url, item);
                    promiseCache.delete(req.url);
                },
                err => {
                    const item: QueryCacheItem = {
                        data: null,
                        error: err,
                        request: req,
                        lastAccess: Date.now() - requestedAt.getTime(),
                        loadingDur: Date.now() - requestedAt.getTime(),
                        requestedAt: requestedAt.toISOString(),
                    };
                    cache.set(req.url, item);
                    promiseCache.delete(req.url);
                },
            );
        }
        return {kind: 'promise', data: promise};
    }
    item.lastAccess = Date.now() - requestedAt.getTime();
    if (item.error) {
        return {kind: 'error', data: item.error};
    }
    return {kind: 'data', data: item.data};
}

function getValidator(req: RequestData) {
    return req.responseType === null ? null : map.get(req.responseType.id) ?? null;
}

export function createReactRestApi<Config, T>(_apiFactory: (config: Config, cache: QueryCache) => T) {
    const context = React.createContext(cast<T>(null));
    return {
        apiContext: context,
        ApiProvider: (props: {api: T; children: React.ReactNode}) =>
            React.createElement(context.Provider, {value: props.api, children: props.children}),
        useApi: () => React.useContext(context),
    };
}
