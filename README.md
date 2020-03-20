
# React-APIO

[![MinGzip](https://badgen.net/bundlephobia/minzip/react-apio)](https://bundlephobia.com/result?p=react-apio@1.0.3)

APIO is absolutely typed rest api client for React.

No more worry about api typings and refactoring.

It uses react hooks and suspense, so you don't need redux or mobx to save http request responses anymore.

## Features

🔥 100% Typed absolutely all aspects

🚀 React Suspense and hooks

⚡️️ 2kb gzipped

🎹 Multiple response types from one api method 200/401/404...

🦄 Node & Browser Support

🔭 All api layer things in one place

💎 Use any implemetation of fetch - es6 fetch/axios/fake fetch/node request...

🏝 Calm api refactoring

## Documentation

Soon

## How it works

```tsx
const ApiFactory = createApiFactory()
    .group(...)
    .query(...)
    .mutation(...)

const {ApiProvider, useSuspense, useMutation, useApi} = createReactApiTools(ApiFactory);

// your fetch, should returns {status: number; data: unknown} | {status: 'ConnectionFailed'; data: Error} | {status: 'JsonParseError'; data: Error} 
// promise error is not handled

const fetcher = (req: RequestData): Promise<FetchResponse> =>
    fetch('https://youdomain/' + req.url, {
        method: req.method,
        headers: {
            'Content-Type': 'application/json',
            'api-key': '.......',
        },
        body: req.method === 'get' ? undefined : JSON.stringify(req.json),
    }).then(
        response =>
            response.json().then(
                json => ({status: response.status, data: json}),
                err => (response.ok ? {status: 'JsonParseError', data: err} : {status: response.status, data: err}),
            ),
        err => ({status: 'ConnectionFailed', data: err}),
    );


function App() {
    const api = ApiFactory({fetcher: fetcher});        
    <ApiProvider api={api}>
       Foo
    </ApiProvider>
}

```

First you need to create api factory, which can be shared between any react apps (react native/web/ssr)

Next you should group income responses by buckets

```ts
// here we group all responses into 5 buckets: Success/AuthRequired/NotFound/ClientError/ServerError
.group(res => {
    if (res.status >= 200 && res.status < 300) return box('Success', res.responseValue);
    if (res.status === 401) return box('AuthRequired', res.responseValue as AuthRequired);
    if (res.status === 404) return box('NotFound', res.responseValue as NotFound);
    if (res.status >= 400 && res.status < 500) return box('ClientError', res.responseValue);
    return box('ServerError', null);
})
```

Then you should specify all your query api methods - `GET` requests, which can be cached

```ts
.query((r/*utilities*/) => ({
    // name to use in your components
    getTodos: {
        request: (params: {limit: number}) => r.get(/*url*/'todos', params /*get query params*/),
        // here we proxy only Success type from our groupped response with Todo[] type
        response: r.onSuccess<Todo[]>(),
        // or if you want to check response type
        response: r.onSuccess(val => {
            if (!Array.isArray(val)) throw new TypeError('Incorrect response type');
            return val as Todo[];
        }),
        // or we pass three response types to components: Success, NotFound, ClientError as MyError
        response: r.onSuccess<Todo[]>().passthrough('NotFound').passthroughNamedTyped('ClientError', 'MyError', val => val as MyError)
    },
}))
```

Same we specify mutations - `PUT`, `POST`, `DELETE` requests
```ts
.mutation(r => ({
    addTodo: {
        request: (todo: {name: string}) => r.post('todo', params/*payload*/),
        response: r.onSuccess<void>(),
        // here we should clear getTodos cache, and all components which uses useSuspense().getTodos(...) automatically will be refreshed
        effectOnSuccess: () => r.cache.deleteByName('getTodos'),
    },
}))
```

Then after api factory is done you create react utils which will used in react components
```tsx

const {ApiProvider, useSuspense, useMutation, useApi} = createReactApiTools(ApiFactory);

function App() {
    const api = ApiFactory({fetcher: fetcher})
    <ErrorBoundary>
        <React.Suspense fallback="Loading...">
            <ApiProvider api={api}>
                <Todos/>
            </ApiProvider>
        </React.Suspense>
    </ErrorBoundary>
}

function Todos() {
    // Return type is Box<'Success', Todo[]> which shorter type of {type: 'Success', value: Todo[]} 
    // or Box<'Success', Todo[]> | Box<'NotFound', NotFound> | Box<'MyError', MyError> if you have used passthough
    const todos = useSuspense().getTodos({limit: 10})
    // if error will happen like ServerError or ConnectionFailed it will be thrown as ApiError and should be handled by ErrorBoundary
    return (
        <div>
            {todos.kind === 'Success' && todos.value.map(todo => <div>{todo.name}</div>)}
            {todos.kind === 'MyError' && <div>Some Error</div>}
        </div>
    )
}

function AddTodo(props: {id: number}) {
    const [name, setName] = React.createState('');
    // after create new todo Todos component will be refreshed
    // status type is Empty | Loading | Result from addTodo implementation: Box<'Empty', void> | Box<'Loading', void> | Box<'Success', void>
    const [status, createTodo] = useMutation(api => api.addTodo({name: name}))
    return (
        <div>
            <input value={name} onChange={setName} />
            <button disabled={status.type === 'Loading'} onClick={createTodo}>Create</button>  
        </div>
    )
}

```

## Complex Example

```tsx
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import {ApiError, box, Box, createApiFactory, createReactApiTools, fakeFetchFactory, Fetcher} from 'react-apio';

type Profile = {name: string};
type AuthRequired = {err: string};
type NotFound = {err: string};
type Status = {status: string};

const restApiFactory = createApiFactory()
    // group responses to buckets by status code
    .group(res => {
        if (res.status >= 200 && res.status < 300) return box('Success', res.data);
        if (res.status === 401) return box('AuthRequired', res.data as AuthRequired);
        if (res.status === 404) return box('NotFound', res.data as NotFound);
        if (res.status >= 400 && res.status < 500) return box('ClientError', res.data);
        return box('ServerError', res.data);
    })
    .query(r => ({
        /** Get my profile */
        getProfile() {
            const res = r.get('profile');
            switch (res.responseValue.type) {
                case 'Success':
                    return res.responseValue as Box<'Success', Profile>;
            }
            // gives stacktrace and full request and response info
            throw new ApiError(res);
        },
        /** Get user profile */
        getUserProfile(params: {userId: string}) {
            const res = r.get(`users/${params.userId}`);
            switch (res.responseValue.type) {
                case 'Success':
                    return res.responseValue as Box<'Success', Profile>;
                case 'NotFound':
                    return res.responseValue;
            }
            throw new ApiError(res);
        },
    }))
    .mutation(r => ({
        /** Login to system */
        async login(params: {login: string; password: string}) {
            const res = await r.post('login', params);
            switch (res.responseValue.type) {
                case 'Success':
                    // delete profile cache
                    // will reload all components which use useSuspense().getProfile()
                    // you can also use predicate to specify which requests you want to delete
                    // r.cache.deleteByName('getUserProfile', p => p.params.userId === '1')
                    r.cache.deleteByName('getProfile');
                    return res.responseValue;
            }
            throw new ApiError(res);
        },
        /** Logout */
        async logout() {
            const res = await r.post('logout');
            switch (res.responseValue.type) {
                case 'Success':
                    r.cache.deleteByName('getProfile');
                    return res.responseValue;
            }
            throw new ApiError(res);
        },
    }));

const {ApiProvider, useSuspense, useMutation, useApi} = createReactApiTools(restApiFactory);

function App() {
    const api = restApiFactory({
        fetcher(req) {
            /* you can use es6 fetch/axios/fake fetch or anything you want */
            // return fakeFetch(req);
            return fetcher(req);
        },
    });

    return (
        <React.Suspense fallback="Loading...">
            <ApiProvider api={api}>
                <ErrorBoundary>
                    <UserProfilePage />
                    <AuthZone>
                        <MyProfilePage />
                    </AuthZone>
                </ErrorBoundary>
            </ApiProvider>
        </React.Suspense>
    );
}

function UserProfilePage() {
    const userProfile = useSuspense().getUserProfile({userId: '1'}); // Box<"NotFound", NotFound> | Box<"Success", Profile>
    return (
        <div>
            {userProfile.type === 'Success' && <h1>Profile of {userProfile.value.name}</h1>}
            {userProfile.type === 'NotFound' && <h1>Profile not found {userProfile.value.err}</h1>}
        </div>
    );
}

function MyProfilePage() {
    const profile = useSuspense().getProfile(); // Box<"Success", Profile>
    const [logoutResult, logout] = useMutation(mut => mut.logout());
    // logoutResult: Box<"Empty"> | Box<"Loading"> | Box<"Success", unknown>
    return (
        <h1>
            Hello {profile.value.name}
            <button disabled={logoutResult.type === 'Loading'} onClick={logout}>
                Logout
            </button>
        </h1>
    );
}

function LoginForm(props: {onLogin: () => void}) {
    const [loginResult, login] = useMutation(api =>
        api.login({login: 'foo', password: 'bar'}).then(data => {
            if (data.type === 'Success') {
                props.onLogin();
            }
            return data;
        }),
    );
    return (
        <div>
            <button disabled={loginResult.type === 'Loading'} onClick={login}>
                Login
            </button>
        </div>
    );
}

function ErrorView(props: {children: React.ReactNode; tryAgain?: () => void}) {
    return (
        <div>
            {props.children}
            {props.tryAgain && (
                <div>
                    <button onClick={props.tryAgain}>Try Again</button>
                </div>
            )}
        </div>
    );
}

// Utility to wrap auth zones with boundary.
// If authRequired response will be thrown in a deep component then LoginForm will be shown
const AuthZone = createBoundary(function AuthZone(props) {
    const err = props.error;
    if (err !== null) {
        if (restApiFactory.isResponseError(err) && err.response.responseValue.type === 'AuthRequired') {
            return <LoginForm onLogin={props.resetError} />;
        }
        // rethrow error to upper ErrorBoundary if other error
        throw props.error;
    }
    return <>{props.children}</>;
});

const ErrorBoundary = createBoundary(
    function ErrorBoundary(props) {
        const api = useApi();
        const tryAgain = () => {
            // clear whole cache
            api.cache.clearAll();
            props.resetError();
        };
        const error = props.error;
        if (error !== null) {
            if (restApiFactory.isResponseError(error)) {
                const res = error.response.responseValue;
                if (res.type === 'ServerError') {
                    return <ErrorView tryAgain={tryAgain}>Internal Server Error</ErrorView>;
                }
                if (res.type === 'ConnectionFailed') {
                    return <ErrorView tryAgain={tryAgain}>Connection Failed</ErrorView>;
                }
                if (res.type === 'UnacceptableResponse') {
                    return <ErrorView>Unacceptable Response</ErrorView>;
                }
                if (res.type === 'NotFound') {
                    return <ErrorView>Not Found</ErrorView>;
                }
            }
            return <ErrorView>Something Went Wrong</ErrorView>;
        }
        return <>{props.children}</>;
    },
    {
        didCatch: (error: Error, errorInfo: React.ErrorInfo) => {
            if (restApiFactory.isResponseError(error)) {
                console.error(error, error.response, errorInfo.componentStack);
            } else {
                console.error(error, errorInfo.componentStack);
            }
        },
    },
);

const fetcher: Fetcher = req =>
    fetch('https://yourdomain/' + req.url, {
        method: req.method,
        headers: {
            'Content-Type': 'application/json',
            'api-key': '.......',
        },
        body: req.method === 'get' ? undefined : JSON.stringify(req.body),
    }).then(res => (res.status < 500 ? res.json() : null));

// Fake fetch
let logged = false;
let serverErrored = true;
const fakeFetch = fakeFetchFactory({
    wait: 500,
    handler: (req, res) => {
        console.log('fetch', req.method, req.url, req.body);
        // if you want test connection failed
        // return res('ConnectionFailed', null);
        switch (req.url) {
            case 'login':
                logged = true;
                // emulate 500 error on first login time
                if (serverErrored) {
                    serverErrored = false;
                    return res(500, null);
                }
                return res<Status>(200, {status: 'ok'});

            case 'logout':
                logged = false;
                return res<Status>(200, {status: 'ok'});

            case 'profile':
                if (logged) return res<Profile>(200, {name: 'Jordan'});
                return res<AuthRequired>(401, {err: 'Auth needed'});

            case 'users/1':
                return res<Profile>(200, {name: 'Shock'});

            case 'users/2':
                return res<NotFound>(404, {err: 'Not Found'});
        }
    },
});

ReactDOM.render(<App />, document.getElementById('root'));

// to prevent noisy uncaught errors
window.addEventListener('error', event => {
    if (event.error instanceof ApiError) {
        event.preventDefault();
    }
});

// utility to create error boundary as functional components
function createBoundary(
    Component: React.FunctionComponent<{error: Error | null; resetError: () => void; children: React.ReactNode}>,
    config?: {didCatch?: (error: Error, errorInfo: React.ErrorInfo) => void},
) {
    return class Boundary extends React.Component<{}, {error: Error | null}> {
        state: {error: Error | null} = {error: null};
        static getDerivedStateFromError(error: Error) {
            return {error: error};
        }
        componentDidCatch = config?.didCatch;
        reset = () => this.setState({error: null});
        render() {
            return <Component error={this.state.error} resetError={this.reset} children={this.props.children} />;
        }
    };
}

```

