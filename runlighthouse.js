#!/usr/bin/env node

/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const { spawnSync } = require('child_process');
const fetch = require('node-fetch'); // polyfill
const minimist = require('minimist');
const parseGitConfig = require('parse-git-config');

const CI_HOST = process.env.CI_HOST || 'https://lighthouse-ci.appspot.com';
const API_KEY = process.env.LIGHTHOUSE_API_KEY || process.env.API_KEY;
const RUNNERS = {chrome: 'chrome', wpt: 'wpt'};

if (process.env.API_KEY) {
  console.log('Warning: The environment variable API_KEY is deprecated. Please use LIGHTHOUSE_API_KEY instead.');
}

function printUsageAndExit() {
  const usage = `Usage:
runLighthouse.js [--score=<score>] [--no-comment] [--runner=${Object.keys(RUNNERS)}] <url>

Options:
  --score      Minimum score for the pull request to be considered "passing".
               If omitted, merging the PR will be allowed no matter what the score. [Number]

  --no-comment Doesn't post a comment to the PR issue summarizing the Lighthouse results. [Boolean]

  --runner     Selects Lighthouse running on Chrome or WebPageTest. [--runner=${Object.keys(RUNNERS)}]

  --help       Prints help.

Examples:

  Runs Lighthouse and posts a summary of the results.
    runLighthouse.js https://example.com

  Fails the PR if the score drops below 93. Posts the summary comment.
    runLighthouse.js --score=93 https://example.com

  Runs Lighthouse on WebPageTest. Fails the PR if the score drops below 93.
    runLighthouse.js --score=93 --runner=wpt --no-comment https://example.com`;

  console.log(usage);
  process.exit(1);
}

function getPrInfoFromApi() {
  return Promise.resolve()
    .then(() => {
      const { stderr, stdout } = spawnSync('git', ['name-rev', process.env.TRAVIS_COMMIT, '--name-only']);
      const error = stderr.toString();

      if (error) {
        throw Error('Couldn\'t read git branch name: ' + error);
      }

      return {
        branch: stdout.toString(),
        owner: getRepoSlugFromFile().split('/').shift(),
        slug: getRepoSlugFromFile(),
      };
    })
    .catch(error => {
      console.error('Lighthouse failed: Couldn\'t read git config from file.');

      throw error;
    })
    .then(({ branch, slug, owner }) =>
      fetch(`https://api.github.com/repos/${slug}/pulls?state=open&head=${owner}:${branch}`)
        .then(resp => resp.json())
        .then(pulls => {
          if (pulls.length === 0 || pulls.message) {
            throw Error(`Couldn't find any matching PR for ${branch} at ${slug}.`);
          }

          const pull = pulls.pop();

          return {
            number: pull.number,
            sha: pull.head.sha,
          };
        }));
}

function getRepoSlugFromFile() {
  const { url } = parseGitConfig.sync()['remote "origin"'];

  if (url.indexOf('http') === 0) {
    const parts = url.split('://').pop().split('/');

    return parts.slice(parts.length - 2).join('/').slice(0, -4);
  }

  return url.slice(url.lastIndexOf(':') + 1).slice(0, -4);
}

function getRepoInfoFromSlug(slug) {
  return {
    owner: slug.split('/')[0],
    name: slug.split('/')[1]
  };
}

/**
 * Collects command lines flags and creates settings to run LH CI.
 * @return {!Object} Settings object.
 */
function getConfig() {
  const args = process.argv.slice(2);
  const argv = minimist(args, {
    boolean: ['comment', 'help'],
    default: {comment: true},
    alias: {help: 'h'}
  });
  const config = {};

  if (argv.help) {
    printUsageAndExit();
  }

  config.testUrl = argv._[0];
  if (!config.testUrl) {
    console.log('Please provide a url to test.');
    printUsageAndExit();
  }

  config.addComment = argv.comment;
  config.minPassScore = Number(argv.score);
  if (!config.addComment && !config.minPassScore) {
    console.log('Please provide a --score when using --no-comment.');
    printUsageAndExit();
  }

  config.runner = argv.runner || RUNNERS.chrome;
  const possibleRunners = Object.keys(RUNNERS);
  if (!possibleRunners.includes(config.runner)) {
    console.log(
        `Unknown runner "${config.runner}". Options: ${possibleRunners}`);
    printUsageAndExit();
  }
  console.log(`Using runner: ${config.runner}`);

  if (process.env.TRAVIS_PULL_REQUEST) {
    console.log('This is a PR, reading config from Travis env variables.');

    return Promise.resolve({
      ...config,
      pr: {
        number: parseInt(process.env.TRAVIS_PULL_REQUEST, 10),
        sha: process.env.TRAVIS_PULL_REQUEST_SHA,
      },
      repo: getRepoInfoFromSlug(process.env.TRAVIS_PULL_REQUEST_SLUG),
    });
  } else {
    console.log('Reading config from current git repository.');

    return getPrInfoFromApi()
      .then(pr => ({
        ...config,
        pr,
        repo: getRepoInfoFromSlug(getRepoSlugFromFile()),
      }));
  }
}

/**
 * @param {!Object} config Settings to run the Lighthouse CI.
 */
function run(config) {
  let endpoint;
  let body = JSON.stringify(config);

  switch (config.runner) {
    case RUNNERS.wpt:
      endpoint = `${CI_HOST}/run_on_wpt`;
      break;
    case RUNNERS.chrome: // same as default
    default:
      endpoint = `${CI_HOST}/run_on_chrome`;
      body = JSON.stringify(Object.assign({output: 'json'}, config));
  }

  fetch(endpoint, {method: 'POST', body, headers: {
    'Content-Type': 'application/json',
    'X-API-KEY': API_KEY
  }})
  .then(resp => resp.json())
  .then(json => {
    if (config.runner === RUNNERS.wpt) {
      console.log(
          `Started Lighthouse run on WebPageTest: ${json.data.target_url}`);
      return;
    }
    console.log('Lighthouse CI score:', json.score);
  })
  .catch(err => {
    console.log('Lighthouse CI failed', err);
    process.exit(1);
  });
}

getConfig()
  .catch(error => {
    console.error('Lightouse CI failed: Couldn\'t find any valid config.');
    console.error(error);
    process.exit(0);
  })
  .then(c => run(c));