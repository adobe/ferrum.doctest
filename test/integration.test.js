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

/* global it, describe */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const process = require('process');
const { strictEqual: ckIs } = require('assert');
const childProcess = require('child_process');
const { promisify } = require('util');
const { assertEquals: ckEq, join, type, each, range0 } = require('ferrum');
const { makeSquirrelly, defaultTemplate } = require('ferrum.doctest');
const { mkTmpDir } = require('ferrum.doctest/cli');
const { ckThrows } = require('./util');

const exec = promisify(childProcess.execFile);
const readFile = (file) => promisify(fs.readFile)(file, 'utf-8');

// Deal with relative paths in our fixtures by using the squirrel
// template engine
const sqrl = (tmpl) =>
  makeSquirrelly().Render(tmpl, {
    test_dir: __dirname,
    proj_dir: path.resolve(path.join(__dirname, '..')),
  });

const test = (what, ...args) => {
  const last = args.pop();
  const opts = type(last) === Object ? last : { fn: last };
  const { fn, cwd = process.cwd() } = opts;

  it(`$ npx ferrum.doctest ${join(args, ' ')} # ${what}`, async () => {
    const oldDir = process.cwd();
    try {
      process.chdir(cwd);
      await fn(await exec(process.execPath, [`${__dirname}/../cli.js`, ...args]));
    } catch (e) {
      // eslint-disable-next-line
      console.error('Command failed to execute! Output was:\n'
        + `stdout:\n${e.stdout}\n`
        + `stderr:\n${e.stderr}`);
      throw e;
    } finally {
      process.chdir(oldDir);
    }
  });
};

const testFail = (what, ...args) => {
  const handler = args.pop();

  it(`$ npx ferrum.doctest ${join(args, ' ')} # ${what} [fail-is-good]`, async () => {
    const err = await ckThrows(Error, () =>
      exec(process.execPath, [`${__dirname}/../cli.js`, ...args]));
    await handler(err);
  });
};

const tmpdir = mkTmpDir('ferrum.doctest-intgration-tests');

describe('integration tests', () => {
  testFail('Missing command', ({ stderr }) => {
    assert(stderr.match('Please specify a command!'));
  });

  testFail('Invalid option', '-v', ({ stderr }) => {
    assert(stderr.match('Unknown argument: v'));
  });

  testFail('Invalid command', 'foo', ({ stderr }) => {
    assert(stderr.match('Unknown argument: foo'));
  });

  testFail('No sources', 'generate', ({ stderr }) => {
    assert(stderr.match('Please specify at least --source or --markdown-source.'));
  });

  test('Empty Output/Stderr', 'generate', '-s', 'no-such-directory', ({ stdout }) => {
    ckIs(stdout, makeSquirrelly().Render(defaultTemplate, { examples: [] }));
  });

  test('Full Generate Fixtures',
    'generate',
    '-s', 'test/fixtures',
    '--mdsrc', 'test/fixtures', async ({ stdout }) => {
      assert(sqrl(await readFile('test/fixtures/out.js.sqrl')).startsWith(stdout));
    });

  test('Full Generate Fixtures +source map',
    'generate',
    '-s', 'test/fixtures',
    '--mdsrc', 'test/fixtures',
    '-o', `${tmpdir}/out.js`, async () => {
      ckIs(
        await readFile(`${tmpdir}/out.js`),
        sqrl(await readFile('test/fixtures/out.js.sqrl')),
      );
      ckEq(
        JSON.parse(await readFile(`${tmpdir}/out.js.map`)),
        JSON.parse(sqrl(await readFile('test/fixtures/out.js.map.sqrl'))),
      );
    });

  testFail('No command', 'exec', ({ stderr }) => {
    assert(stderr.match('Please specify a command either in the arguments or with -c.'));
  });

  testFail('Missing parameter value', 'exec', '-p', ({ stderr }) => {
    assert(stderr.match('Not enough arguments following: p'));
  });

  testFail('Bad package.json location',
    'exec',
    '--mdsrc', 'test/fixtures',
    '-p', 'not/a/package/json',
    'echo', 'Hello', '--', 'World', async () => {
    // nop
    });

  test('Full Exec Test',
    'exec',
    '-s', path.join(__dirname, 'fixtures'),
    '--mdsrc', path.join(__dirname, 'fixtures'),
    '-c', 'npx mocha -t 20000 "$DOCTEST_FILE"', {
      cwd: path.join(__dirname, 'fixtures'),
      async fn({ stdout }) {
        each(range0(18), (no) => assert(stdout.match(`Example ${no + 1}`)));
        const dir = path.join(__dirname, 'fixtures');
        assert(stdout.match(`dirname: ${dir}`));
        assert(stdout.match(`filename: ${path.join(dir, 'dummy3.md')}`));
      },
    });

  test('Argument based command',
    'exec',
    '--mdsrc', path.join(__dirname, 'fixtures'),
    '-p', path.resolve(path.join(__dirname, '..', 'package.json')),
    'echo', 'Hello', '--', 'World', {
      cwd: path.join(__dirname, '..', '..', '..', '..'),
      async fn({ stdout }) {
        assert(stdout.match('Hello World'));
      },
    });

  testFail('Reporting syntax errors',
    'generate',
    '--mdsrc', path.join(__dirname, 'fixtures-syntax-error/syntax-errors.md'),
    async ({ stdout, stderr }) => {
      ckIs(stdout, '');

      const expect = sqrl(await readFile('test/fixtures-syntax-error/error_output.txt.sqrl'));
      ckIs(
        // Without stack trace and with normalized error message
        stderr.replace(/SyntaxError: Unexpected token.*\n(\s+at.*\n)*$/, 'SyntaxError: Unexpected token\n'),
        expect,
      );
    });
});
