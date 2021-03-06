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
'use strict'

const fetch = require('node-fetch')
const minimist = require('minimist')

const {
  CI_HOST = 'https://lighthouse-ci.appspot.com',
  LIGHTHOUSE_API_KEY,
  CIRCLE_SHA1,
  CIRCLE_PULL_REQUEST,
  CIRCLE_REPOSITORY_URL
} = process.env

const RUNNERS = {chrome: 'chrome', wpt: 'wpt'}

// Get PR number from CIRCLE_PULL_REQUEST
// CIRCLE_PR_NUMBER only available for forked builds, doh!
const prNumber = CIRCLE_PULL_REQUEST.slice(-2)

function printUsageAndExit () {
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

  console.log(usage)
  process.exit(1)
}

/**
 * Collects command lines flags and creates settings to run LH CI.
 * @return {!Object} Settings object.
 */
function getConfig() {
  const args = process.argv.slice(2)
  const argv = minimist(args, {
    boolean: ['comment', 'help'],
    default: { comment: true },
    alias: { help: 'h' }
  })
  const config = {}

  if (argv.help) {
    printUsageAndExit()
  }

  config.testUrl = argv._[0]

  if (!config.testUrl) {
    console.log('Please provide a url to test.')
    printUsageAndExit()
  }

  config.addComment = argv.comment
  config.minPassScore = Number(argv.score)

  if (!config.addComment && !config.minPassScore) {
    console.log('Please provide a --score when using --no-comment.')
    printUsageAndExit()
  }

  config.runner = argv.runner || RUNNERS.chrome
  const possibleRunners = Object.keys(RUNNERS)

  if (!possibleRunners.includes(config.runner)) {
    console.log(`Unknown runner "${config.runner}". Options: ${possibleRunners}`)
    printUsageAndExit()
  }
  console.log(`Using runner: ${config.runner}`);

  config.pr = {
    number: prNumber,
    sha: CIRCLE_SHA1
  };

  const pullRequest = CIRCLE_REPOSITORY_URL.split(':')[1]

  config.repo = {
    owner: pullRequest.split('/')[0],
    name: pullRequest.split('/')[1].split('.')[0]
  }

  return config
}

/**
 * @param {!Object} config Settings to run the Lighthouse CI.
 */
function run(config) {
  let endpoint
  let body = JSON.stringify(config)

  switch (config.runner) {
    case RUNNERS.wpt:
      endpoint = `${CI_HOST}/run_on_wpt`
      break;
    case RUNNERS.chrome: // same as default
    default:
      endpoint = `${CI_HOST}/run_on_chrome`
      body = JSON.stringify(Object.assign({output: 'json'}, config))
  }

  fetch(endpoint, {method: 'POST', body, headers: {
    'Content-Type': 'application/json',
    'X-API-KEY': LIGHTHOUSE_API_KEY
  }})
  .then(resp => resp.json())
  .then(json => {
    if (config.runner === RUNNERS.wpt) {
      console.log(`Started Lighthouse run on WebPageTest: ${json.data.target_url}`)
      return
    }
    console.log('Lighthouse CI score:', json.score)
  })
  .catch(err => {
    console.log('Lighthouse CI failed', err)
    process.exit(1)
  })
}

// Run LH if this is a PR.
const config = getConfig()

if (!isNaN(parseFloat(prNumber)) && isFinite(prNumber)) {
  run(config)
} else {
 console.log('Lighthouse is not run for non-PR commits.')
}
