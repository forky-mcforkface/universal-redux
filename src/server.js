// node modules dependencies
import Express from 'express';
import React from 'react';
import ReactDOM from 'react-dom/server';
import favicon from 'serve-favicon';
import compression from 'compression';
import path from 'path';
import PrettyError from 'pretty-error';
import { each } from 'lodash';
import {ReduxRouter} from 'redux-router';
import createHistory from 'history/lib/createMemoryHistory';
import {reduxReactRouter, match} from 'redux-router/server';
import {Provider} from 'react-redux';
import qs from 'query-string';
import WebpackIsomorphicTools from 'webpack-isomorphic-tools';

// dependencies of serverside render
import ApiClient from './helpers/ApiClient';
import createStore from './redux/create';
import Html from './helpers/Html';
import getStatusFromRoutes from './helpers/getStatusFromRoutes';

let app;
let hasSetup = false;
let isomorphicTools;
let config = require('../config/universal-redux.config.js');
let toolsConfig = require('../config/webpack-isomorphic-tools-config');

/**
 * Define isomorphic constants.
 */
global.__CLIENT__ = false;
global.__SERVER__ = true;
global.__DISABLE_SSR__ = false;  // <----- DISABLES SERVER SIDE RENDERING FOR ERROR DEBUGGING
global.__DEVELOPMENT__ = process.env.NODE_ENV !== 'production';
global.__CONFIG__ = config;

function setupTools(rootDir) {
  toolsConfig.webpack_assets_file_path = rootDir + '/webpack-assets.json';

  isomorphicTools = new WebpackIsomorphicTools(toolsConfig);
  isomorphicTools
    .development(__DEVELOPMENT__)
    .server(rootDir);
}

function setupAssets(rootDir) {
  app.use(favicon(path.join(rootDir, 'static', 'favicon.ico')));
  app.use(Express.static(path.resolve(rootDir, 'static')));
}

function setupRenderer() {
  app.use((req, res) => {

    const getRoutes = require(path.resolve(config.routes));
    const reducers = require(path.resolve(config.reducers));

    let CustomHtml;
    if (config.html) {
      CustomHtml = require(path.resolve(config.html));
    } else {
      CustomHtml = Html;
    }

    if (__DEVELOPMENT__) {
      // Do not cache webpack stats: the script file would change since
      // hot module replacement is enabled in the development env
      isomorphicTools.refresh();
    }
    const pretty = new PrettyError();

    const client = new ApiClient(req);
    const store = createStore(reduxReactRouter, getRoutes, createHistory, client, reducers);

    function hydrateOnClient() {
      res.send('<!doctype html>\n' + ReactDOM.renderToString(<CustomHtml assets={isomorphicTools.assets()} store={store}/>));
    }

    if (__DISABLE_SSR__) {
      hydrateOnClient();
      return;
    }

    store.dispatch(match(req.originalUrl, (error, redirectLocation, routerState) => {
      if (redirectLocation) {
        res.redirect(redirectLocation.pathname + redirectLocation.search);
      } else if (error) {
        console.error('ROUTER ERROR:', pretty.render(error));
        res.status(500);
        hydrateOnClient();
      } else if (!routerState) {
        res.status(500);
        hydrateOnClient();
      } else {
        // Workaround redux-router query string issue:
        // https://github.com/rackt/redux-router/issues/106
        if (routerState.location.search && !routerState.location.query) {
          routerState.location.query = qs.parse(routerState.location.search);
        }

        store.getState().router.then(() => {
          const component = (
            <Provider store={store} key="provider">
              <ReduxRouter/>
            </Provider>
          );

          const status = getStatusFromRoutes(routerState.routes);
          if (status) {
            res.status(status);
          }
          res.send('<!doctype html>\n' + ReactDOM.renderToString(<CustomHtml assets={isomorphicTools.assets()} component={component} store={store} headers={res._headers} />));
        }).catch((err) => {
          console.error('DATA FETCHING ERROR:', pretty.render(err));
          res.status(500);
          hydrateOnClient();
        });
      }
    }));
  });
}

function validateConfig() {
  const errors = [];
  if (!config) {
    errors.push('==>     ERROR: No configuration supplied.');
  }
  if (config.server) {
    if (!config.server.host) {
      errors.push('==>     ERROR: No host parameter supplied.');
    }
    if (!config.server.port) {
      errors.push('==>     ERROR: No port parameter supplied.');
    }
  }
  if (!config.routes) {
    errors.push('==>     ERROR: Must supply routes.');
  }
  if (!config.reducers) {
    errors.push('==>     ERROR: Must supply reducers.');
  }
  // TODO: check for more
  return errors;
}

export default class Renderer {

  static configure(userConfig, userToolsConfig) {
    if (!hasSetup) {
      Renderer.app();
    }

    config = userConfig;
    config.apiPrefix = userConfig.apiPrefix || 'api';

    // for access during serverside rendering, which
    // does not have access to the webpack alias
    global.__CONFIG__ = config;

    if (userToolsConfig) {
      toolsConfig = userToolsConfig;
    }
    const errors = validateConfig();

    if (errors.length > 0) {
      console.log('Configuration errors for universal-redux.');
      each(errors, (error) => { console.error(error); });
    } else {
      console.log('universal-redux configuration is valid.');
    }
  }

  static app(userSuppliedApp) {
    app = userSuppliedApp || new Express();
    app.use(compression());

    hasSetup = true;

    return app;
  }

  static setup(userConfig, userToolsConfig) {
    if (userConfig) {
      Renderer.configure(userConfig, userToolsConfig);
    }

    let rootDir;
    if (config.webpack.config.context) {
      rootDir = path.resolve(config.webpack.config.context);
    } else {
      rootDir = path.resolve(__dirname, '..');
    }

    setupTools(rootDir);
    setupAssets(rootDir);
    setupRenderer();
  }

  static start() {
    if (!hasSetup) {
      Renderer.app();
    }

    app.listen(config.server.port, (err) => {
      if (err) {
        console.error(err);
      }
      console.info('----\n==> ✅  %s is running.', config.app.title);
      console.info('==> 💻  Open http://%s:%s in a browser to view the app.', config.server.host, config.server.port);
    });
  }
}
