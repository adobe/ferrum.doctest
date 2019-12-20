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
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process')
const { tmpdir } = require('os');
const { promisify } = require('util');
const { strictEqual: ckIs, AssertionError } = require('assert');
const { v4: uuid } = require('uuid');
const { assertEquals: ckEq, pipe, extend, takeUntil, list, append, type, typename, reject, map } = require('ferrum');
const { isRoot, liftArray, transformStringList, findPkg, onChildExit, mkTmpDir, rmRecursiveSync } = require('ferrum.doctest/cli');
const { ckThrows } = require('./util');

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const stat = promisify(fs.stat);

const exists = async (file) => {
  try {
    await stat(file);
    return true;
  } catch (_) {
    return false;
  }
};

it('isRoot', () => {
  // Should yield finite path
  // This will simply never exit if isRoot
  pipe(
    extend('.', (p) => p + '/..'),
    takeUntil(isRoot),
    list);
});

it('liftArray', () => {
  let nop = (v) => ckIs(v, liftArray(v));
  let wrp = (v) => {
    const w = liftArray(v);
    ckIs(type(w), Array);
    ckIs(w.length, 1);
    ckIs(w[0], v);
  };
  nop([]);
  nop(['foo']);
  nop(['foo', 42]);
  nop(['foo', 42, 23]);
  wrp(null);
  wrp('asd');
  wrp(42);
  wrp({});
  wrp(new Set());
});

it('transformStringList', () => {
  const ck = (inp, out, div, ...fns) =>
    ckIs(
      transformStringList(inp, div, ...fns),
      out);

  ck('',      '42;23', ';', append(42), append(23));
  ck('13',    '',      ';', reject(() => true));
  ck('13,42', '26,84', ',', map((v) => Number(v)*2));
});

it('findPkg', async () => {
  const expect = [path.resolve(`${__dirname}/..`), 'ferrum.doctest'];

  // No try parent; directory with package.json
  ckEq(await findPkg(`${__dirname}/..`), expect);

  // No try parent; package.json directly
  ckEq(await findPkg(`${__dirname}/../package.json`), expect);

  // Try parent; subdirectory
  ckEq(await findPkg(`${__dirname}/fixtures/`, { tryParents: true }), expect);

  // No try parent; dir without package.json
  let e = await ckThrows(Error, () => findPkg(__dirname));
  ckIs(e.code, 'ENOENT');

  // Bad package.json
  e = await ckThrows(SyntaxError, () => findPkg(__filename));
  ckIs(e.__findPkgJsonFile, __filename);

  // Something is twisted with you if you have a package.json in your
  // root…still, for the sake of consistency
  if (!await exists('/package.json')) {
    e = await ckThrows(Error, () => findPkg('/', { tryParents: true }));
    ckIs(e.code, 'ENOENT');
  }

  // Try parent; bad package.json
  e = await ckThrows(SyntaxError, () => findPkg(__filename, { tryParents: true }));
  ckIs(e.__findPkgJsonFile, __filename);
});

it('rmRecursiveSync', async () => {
  const ckExists = (f) => stat(f);

  const ckNotExists = async (file) => {
    const e = await ckThrows(Error, () => stat(file));
    ckIs(e.code, 'ENOENT');
  };

  const touch = async (rel) => {
    await writeFile(`${dir}/${rel}`, `Hello World`);
    await ckExists(`${dir}/${rel}`);
  };

  // Directory structure setup
  const dir = `${tmpdir()}/ferrum.doctest-test-remove-recursive-${uuid(9)}`;
  await mkdir(`${dir}/a/b/c/d`, { recursive: true }),
  await mkdir(`${dir}/e/f/g`, { recursive: true }),
  await touch(`h.txt`);
  await touch(`i.txt`);
  await touch(`a/j.txt`);
  await touch(`a/b/c/d/k.txt`);
  await touch(`l.txt`);

  // Delete File
  await ckExists(`${dir}/l.txt`);
  rmRecursiveSync(`${dir}/l.txt`);
  await ckNotExists(`${dir}/l.txt`);

  // Delete Directory
  await ckExists(`${dir}/h.txt`);
  rmRecursiveSync(dir);
  await ckNotExists(`${dir}/h.txt`);
  await ckNotExists(dir);
});
