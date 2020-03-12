# restio

RestIO is absolutely typed rest api client for React. 

No more worry about api refactoring. 

It uses react hooks and suspense, so you don't need redux or mobx to save http request responses anymore. 

## Usage
```ts
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import {createRestApiFactory, createReactRestApi, r, QueryCache, Fetcher} from 'restio';

/* use es6 fetch or anything you want, for example axios*/
const fetcher: Fetcher<{prefix: string; apiKey: string}> = config => req =>
    fetch({
        url: config.prefix + req.url,
        method: req.method,
        headers: {
            'Content-Type': 'application/json',
            ApiKey: config.apiKey,
        },
        body: JSON.stringify(req.json),
    } as any).then(res => res.json());

const restApiFactory = createRestApiFactory(fetcher, {
    // specify query methods
    query: {
        /** Get my profile */
        getProfile: () => r.get(/*should be same as key*/ 'getProfile', /*url*/ '/profile/', /*response type comes from validator*/ ProfileValidator),

        getUserProfile: (params: {userId: string}) =>
            r.get('getUserProfile', /*url*/ `/user-profile/${params.userId}`, ProfileValidator),
    },
    // specify mutation methods
    mutation: {
        /** Login to system */
        login: (params: {login: string; password: string}) => r.post('login', '/login/', params, StatusValidator),

        logout: () => r.post('logout', '/logout/', null, StatusValidator),
    },
});

type Profile = {name: string};
const ProfileValidator = (p: Profile | null) => {
    /* validator logic */
};
type Status = {status: string};
const StatusValidator = (p: Status) => {
    /* validator logic */
};

const {ApiProvider, useApi} = createReactRestApi(restApiFactory);


function App() {
    const cache: QueryCache = new Map();
    const api = restApiFactory({apiKey: 'x', prefix: '/api/'}, cache);
    console.log(cache);

    return (
        <React.Suspense fallback="Loading...">
            <ApiProvider api={api}>
                <Hello />
            </ApiProvider>
        </React.Suspense>
    );
}

function Hello() {
    const api = useApi();
    const profile = api.suspense.getProfile(); // Profile | null
    return (
        <div>
            {profile ? (
                <h1>
                    Hello {profile.name}
                    <button onClick={() => api.mutation.logout()}>Logout</button>
                </h1>
            ) : (
                <button onClick={() => api.mutation.login({login: 'foo', password: 'bar'})}>Login</button>
            )}
        </div>
    );
}


ReactDOM.render(<App />, document.getElementById('root'));
```

Mutation and query returns promise with result. Suspense returns just result.
