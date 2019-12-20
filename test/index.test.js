/*
 * Copyright 2019 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* global it */
const { strictEqual: ckIs } = require('assert');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { assertSequenceEquals: ckSeqEq, pipe, map, type, list, mapSort, get } = require('ferrum');
const { makeSquirrelly, findDocExamples, findMarkdownExamples } = require('../');

const readFile = (file) => promisify(fs.readFile)(file, 'utf-8');

it('extractFromDoc, findDocExamples', async () => {
  const generated = pipe(
    await findDocExamples([`${__dirname}/fixtures`]),
    map(({doc, ...fields}) => {
      ckIs(type(doc), Object);
      ckIs(type(doc.description), Object);
      return fields;
    }),
    // Decay any type information in the mdast
    list,
    JSON.stringify,
    JSON.parse);

  const expected = pipe(
    await readFile(`${__dirname}/fixtures/out.js_examples.json.sqrl`),
    (tmpl) => makeSquirrelly().Render(tmpl, { test_dir: __dirname }),
    JSON.parse);

  const sorted = mapSort(get('name'));
  ckSeqEq(
      sorted(generated),
      sorted(expected));
});

it('findMarkdownExamples', async () => {
  const generated = pipe(
    await findMarkdownExamples([`${__dirname}/fixtures`]),
    map(({md, ...fields}) => {
      ckIs(md.type, 'code');
      return fields;
    }));

  const expected = pipe(
    await readFile(`${__dirname}/fixtures/out.md_examples.json.sqrl`),
    (tmpl) => makeSquirrelly().Render(tmpl, { test_dir: __dirname }),
    JSON.parse);

  const sorted = mapSort(get('name'))
  ckSeqEq(
      sorted(generated),
      sorted(expected));
});


// generateTests is tested along with cli.js since cli.js is just generateTests
// with more IO and CLI params…
