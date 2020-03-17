# restio

RestIO is absolutely typed rest api client for React. 

No more worry about api typing and refactoring. 

It uses react hooks and suspense, so you don't need redux or mobx to save http request responses anymore. 

## Usage
```ts
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import {createReactRestApi, createRestApiFactory, fakeFetchFactory, group, ResponseData, RestApiError} from 'restio';

type Profile = {name: string};
type AuthRequired = {err: string};
type NotFound = {err: string};
type Status = {status: string};

// group responses to buckets by status code
function groupResponse(res: ResponseData) {
    if (res.status >= 200 && res.status < 300) return group('success', res.responseValue);
    if (res.status === 401) return group('authRequired', res.responseValue as AuthRequired);
    if (res.status === 404) return group('notFound', res.responseValue as NotFound);
    if (res.status >= 400 && res.status < 500) return group('clientError', res.responseValue);
    return group('serverError', null);
}

const restApiFactory = createRestApiFactory()
    .group(groupResponse)
    .query(r => ({
        /** Get my profile */
        getProfile: {
            request: () => r.get('profile'),
            response: r.onSuccess<Profile>(),
        },

        getUserProfile: {
            request: (params: {userId: string}) => r.get(`users/${params.userId}`),
            response: r
                .onSuccessTyped(val => {
                    // you can transform/normalize value as how you want
                    return val as Profile;
                })
                // Proxy value with notFound type from groupResponse directly without changes
                .proxy('notFound'),
        },
    }))
    .mutation(r => ({
        /** Login to system */
        login: {
            request: (params: {login: string; password: string}) => r.post('login', params),
            response: r.onSuccess<Status>(),
            // if you want to run some side effected after success response do it here
            effectOnSuccess: () => {
                // delete profile cache
                // will reload all components which use useSuspense().getProfile()
                r.cache.deleteByName('getProfile');
            },
        },
        logout: {
            request: () => r.post('logout', null),
            response: r.onSuccess<Status>(),
            effectOnSuccess: () => r.cache.deleteByName('getProfile'),
        },
    }));

const {ApiProvider, useSuspense, useMutation, useApi} = createReactRestApi(restApiFactory);

function App() {
    const api = restApiFactory({
        fetch(req) {
            return fakeFetch(req.method, req.url, req.json);
            /* or use es6 fetch/axios or anything you want */
            // return fetch('https://youdomain/' + req.url, {
            //     method: req.method,
            //     headers: {
            //         'Content-Type': 'application/json',
            //         'api-key': '.......',
            //     },
            //     body: req.method === 'get' ? undefined : JSON.stringify(req.json),
            // }).then(
            //     response =>
            //         response.json().then(
            //             json => ({status: response.status, data: json}),
            //             err =>
            //                 response.ok ? {status: 'JsonParseError', data: err} : {status: response.status, data: err},
            //         ),
            //     err => ({status: 'Failed', data: err}),
            // );
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
    const userProfile = useSuspense().getUserProfile({userId: '1'}); // Group<"notFound", NotFound> | Group<"success", Profile>
    return (
        <div>
            {userProfile.group === 'success' && <h1>Profile of {userProfile.value.name}</h1>}
            {userProfile.group === 'notFound' && <h1>Profile not found {userProfile.value.err}</h1>}
        </div>
    );
}

function MyProfilePage() {
    const profile = useSuspense().getProfile(); // Group<"success", Profile>
    const [logoutResult, logout] = useMutation(mut => mut.logout());
    return (
        <h1>
            Hello {profile.value.name}
            <button disabled={logoutResult.group === 'Loading'} onClick={logout}>
                Logout
            </button>
        </h1>
    );
}

function LoginForm(props: {onLogin: () => void}) {
    const [loginResult, login] = useMutation(api =>
        api.login({login: 'foo', password: 'bar'}).then(data => {
            if (data.group === 'success') {
                props.onLogin();
            }
            return data;
        }),
    );
    return (
        <div>
            <button disabled={loginResult.group === 'Loading'} onClick={login}>
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
    if (props.error !== null) {
        if (restApiFactory.isResponseError(props.error) && props.error.group.group === 'authRequired') {
            return <LoginForm onLogin={props.resetError} />;
        }
        // rethrow error to upper ErrorBoundary
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
                if (error.group.group === 'serverError') {
                    return <ErrorView tryAgain={tryAgain}>Internal Server Error</ErrorView>;
                }
                if (error.group.group === 'failed') {
                    return <ErrorView tryAgain={tryAgain}>Connection Failed</ErrorView>;
                }
                if (error.group.group === 'unacceptableResponse') {
                    return <ErrorView>Unacceptable Response</ErrorView>;
                }
                if (error.group.group === 'notFound') {
                    return <ErrorView>Not Found</ErrorView>;
                }
            }
            return <ErrorView>Something Went Wrong</ErrorView>;
        }
        return <>{props.children}</>;
    },
    (error: Error, errorInfo: React.ErrorInfo) => {
        console.error(error, errorInfo.componentStack);
    },
);

// Fake fetch
let logged = false;
let serverErrored = true;
const fakeFetch = fakeFetchFactory({
    wait: 500,
    handler: (method, url, params, res) => {
        console.log('fetch', method, url, params);
        // if you want test connection failed
        // return res('Failed', null);
        switch (url) {
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
    if (event.error instanceof RestApiError) {
        event.preventDefault();
    }
});

// utility to create error boundary as functional components
function createBoundary(
    Component: React.FunctionComponent<{error: Error | null; resetError: () => void; children: React.ReactNode}>,
    didCatch?: (error: Error, errorInfo: React.ErrorInfo) => void,
) {
    return class Boundary extends React.Component<{}, {error: Error | null}> {
        state: {error: Error | null} = {error: null};
        static getDerivedStateFromError(error: Error) {
            return {error: error};
        }
        componentDidCatch = didCatch;
        reset = () => this.setState({error: null});
        render() {
            return <Component error={this.state.error} resetError={this.reset} children={this.props.children} />;
        }
    };
}

```

Mutation and query returns promise with result. Suspense returns just result.
