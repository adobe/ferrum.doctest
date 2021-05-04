#! /usr/bin/env node
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

/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const process = require('process');
const { statSync, rmdirSync, unlinkSync, readdirSync, mkdirSync } = require('fs');
const { env } = require('process');
const { spawn } = require('child_process');
const { tmpdir } = require('os');
const { promisify } = require('util');
const { exit } = require('process');
const { v4: uuid } = require('uuid');
const {
  type, isdef, xor, pipe, prepend, empty, join, exec, each,
} = require('ferrum');
const { _requireNocache, defaultTemplate, generateTests } = require('.');

// Down with singletons!
const yargs = () => _requireNocache('yargs');

const readFileSync = (file) => fs.readFileSync(file, 'utf-8');
const readFile = (file) => promisify(fs.readFile)(file, 'utf-8');
const writeFile = promisify(fs.writeFile);
const stat = promisify(fs.stat);
const mkdir = promisify(fs.mkdir);
const symlink = promisify(fs.symlink);

/**
 * Used to mark unreachable code. Terminates the process.
 *
 * @function
 * @private
 */
const unreachable = () => {
  console.error('[FATAL] Executing unreachable code! This should not happen.');
  exit(1);
};

/**
 * Test if the given path represents for the root of the file system (on unix)
 * or a drive (on windows).
 *
 * @function
 * @private
 * @param {String} p The path
 * @returns {Boolean}
 */
const isRoot = (p) => {
  // Note: Using this slightly convoluted method for portability
  const p_ = path.resolve(p);
  return path.dirname(p_) === p_;
};

/**
 * Execute a command directly (without a shell)
 *
 * @function
 * @private
 * @param {String[]} cmd
 * @param {Object} opts Extra parameters passed to `child_process.spawn()`
 * @returns {ChildProcess}
 */
const system = (cmd, opts) => {
  const [command, ...args] = cmd;
  return spawn(command, args, {
    stdio: ['inherit', 'inherit', 'inherit'],
    ...opts,
  });
};

/**
 * Execute a system command with a shell
 *
 * @function
 * @private
 * @param {String} shellCode
 * @param {Object} opts Extra parameters passed to `child_process.spawn()`
 * @returns {ChildProcess}
 */
const systemShell = (shellCode, opts) =>
  system([shellCode], { shell: true, ...opts });

/**
 * Wait until a child process exits
 *
 * @function
 * @private
 * @param {ChildProcess} child
 * @returns {Promise<Number>} Promise resolving to the exit code as
 *   soon as the child process exits.
 */
const onChildExit = (child) => new Promise((res) =>
  child.on('exit', (code) =>
    res(code)));

/**
 * Ensure that the given parameter is an array
 *
 * @function
 * @private
 * @param {*} v Arrays will not be modified. Other values will be
 *   wrapped in array.
 * @returns {Array}
 */
const liftArray = (v) => (type(v) === Array ? v : [v]);

/**
 * Transform a list encoded as a value separated string.
 *
 * ```
 * const assert = require('assert');
 * const { map, filter } = require('ferrum');
 * const { transformStringList } = require('ferrum.doctest/cli');
 *
 * assert.strictEqual(
 *   transformStringList('1;2;3;4;5', ';',
 *     map(Number),
 *     filter((v) => (v % 2) !== 0)), // isOdd
 *   '1;3;5');
 * ```
 *
 * @function
 * @private
 * @param {Boolean} v Assertion value.
 * @param {String} msg Error message
 */
const transformStringList = (str, divider, ...fns) => pipe(
  empty(str) ? [] : str.split(divider),
  ...fns,
  join(divider),
);

/**
 * Recursively remove a file/directory and it's children.
 *
 * @function
 * @private
 * @param {String} file The file/directory to remove.
 */
const rmRecursiveSync = (file, _ent) => {
  const ent = isdef(_ent) ? _ent : statSync(file);
  if (!ent.isDirectory()) {
    unlinkSync(file);
  } else {
    const childs = readdirSync(file, { withFileTypes: true });
    each(childs, (sub) =>
      rmRecursiveSync(path.join(file, sub.name), sub));
    rmdirSync(file);
  }
};

/**
 * Create a temp dir. The directory is automatically deleted when
 * the process exits.
 *
 * @function
 * @private
 * @param {String} name Identifier (not path) for the temp directory;
 *   makes it easier for sysadmins to identify where a temp file came
 *   from.
 * @returns {String} The name of the directory
 */
const mkTmpDir = (name) => {
  const dir = `${tmpdir()}/${name}-${uuid()}`;
  process.on('exit', () => rmRecursiveSync(dir));
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * Assert; display yargs help + error message and exit if assertion fails.
 *
 * @function
 * @private
 * @param {Boolean} v Assertion value.
 * @param {String} msg Error message
 */
const assertCliParams = (y, v, msg) => {
  if (!v) {
    y.showHelp();
    console.error(`\n${msg}`);
    y.exit(1);
  }
};

/**
 * Helper for defining yargs commands
 *
 * @function
 * @private
 * @param {Yargs} yargs instance
 * @param {String[]} names Name+aliases of the positional
 * @param {Object} opts
 * @param {String} opts.description
 * @param {String} opts.usage Usage string as taken by `Yargs.usage`
 * @param {Function} args Handler used to specify the options the command takes.
 * @param {Function} handler Will be invoked to further customize the parameter object.
 */
const cmd = (y, names, { description, args, handler, usage }) => {
  const args_ = (y2) => {
    if (isdef(usage)) {
      y2.usage(usage);
    }
    args(y2);
  };
  y.command(names, description, args_, handler);
};

/**
 * Helper for defining a parameter with a single argument
 *
 * @function
 * @private
 * @param {Yargs} yargs instance
 * @param {String[]} names Name of the positional
 * @param {String} type Type of the positional as specified by `Yargs.positional`.
 * @param {String} description. This positional may be omitted.
 * @param {Object} opts Further options will be passed to `Yargs.positional`
 */
const param = (y, names, typ = 'string', description, opts = {}) => {
  if (type(description) === Object) {
    param(y, names, typ, undefined, description);
    return;
  }

  const [name, ...alias] = liftArray(names);
  y.option(name, {
    alias,
    type: typ,
    description,
    nargs: 1,
    requiresArg: true,
    ...opts,
  });
};

/**
 * Helper for defining a positional argument
 *
 * @function
 * @private
 * @param {Yargs} yargs instance
 * @param {String} name Name of the positional
 * @param {String} type Type of the positional as specified by `Yargs.positional`.
 * @param {String} description
 * @param {Object} opts Further options will be passed to `Yargs.positional`
 */
const pos = (y, name, typ, description, opts = {}) =>
  y.positional(name, { type: typ, description, ...opts });

/**
 * Declare the common parameters of both the env and generate cmd.
 *
 * @function
 * @private
 * @param {Yargs} yargs instance
 */
const declareCommonParams = (y) => {
  param(y, ['template', 't'], 'string', {
    default: null,
    coerce: (file) => (isdef(file) ? readFileSync(file) : defaultTemplate),
    description: 'Path of the template to use when generating the test file.',
  });

  param(y, ['source', 'src', 's'], 'string', {
    coerce: liftArray,
    default: [],
    description:
      'The file or directory to search for javascript files with examples. '
      + 'Can be specified multiple times.',
  });

  // https://github.com/yargs/yargs/issues/1939
  param(y, ['mdsrc', 'markdown-source'], 'string', {
    coerce: liftArray,
    default: [],
    description:
      'The file or directory to search for markdown files with examples. '
      + 'Can be specified multiple times.',
  });
};

/**
 * Declare the parameters of the env cmd.
 *
 * @function
 * @private
 * @param {Yargs} yargs instance
 */
const declareExecCmd = (y) => {
  cmd(y, 'exec [argsCommand...]', {
    usage:
      '$0 exec [-t TEMPLATE] [-s JS_SOURCE]... [--mdsrc MD_SOURCE]... [-c SHELL_CODE|COMMAND... [-- COMMAND...]]',
    description:
      'Like the generate command, this will search for examples in the given '
        + 'markdown & javascript files/directories and use them to generate'
        + 'a test file & an associated source map.\n'
      + '\n'
      + 'Unline generate this command will automatically choose a temporary '
        + 'directory to put the test file and source map in and delete the directory '
        + 'after the tests have finished.\n'
      + '\n'
      + 'This will also make `require(\'<yourpackage>\')` calls work by automatically '
        + 'generating a node_modules folder in the temporary directory and adding a symlink '
        + 'to the package you are developing.\n'
      + '\n'
      + 'You can even specify no sources at all if you just nee `require(\'<yourpackage>\')` to work!',
    args(y2) {
      declareCommonParams(y2);
      pos(y2, 'argsCommand', 'string',
        'The command and arguments to execute within the created environment. '
            + 'Use the -- separator if you need to specify options.');
      param(y2, ['package', 'p'], 'string', {
        description:
          'The location of the package.json for which an alias should be generated.\n'
          + '\n'
          + 'Usually the location is automatically detected based on your current directory.',
      });
      param(y2, ['command', 'c'], 'string', {
        description:
          'The location of the package.json for which an alias should be generated.\n'
          + '\n'
          + 'Usually the location is automatically detected based on your current directory.',
      });
    },

    handler(params) {
      const { argsCommand: parsed = [], '--': unparsed = [], command: shellCommand } = params;

      params.argsCommand = [...parsed, ...unparsed];
      delete params['--'];
      params.shellCommand = shellCommand;
      delete params.command;

      assertCliParams(y, xor(!empty(params.argsCommand), isdef(shellCommand)),
        'Please specify a command either in the arguments or with -c.');
    },
  });
};

/**
 * Declare the parameters of the generate cmd.
 *
 * @function
 * @private
 * @param {Yargs} yargs instance
 */
const declareGenerateCmd = (y) => {
  cmd(y, 'generate', { usage: '$0 generate [-t TEMPLATE] [-s JS_SOURCE]... [--mdsrc MD_SOURCE]... [-o FILE] [-m MAP_FILE]',
    description: 'Generate a test file from the given examples.\n\n'
      + 'This will iterate over all the files/directories containing '
        + 'javascript/markdown files and extract the examples. '
        + 'These will be passed through the given template to generate '
        + 'test files suitable for use with your test runner.\n'
      + '\n'
      + 'A souce map file will also be generated alongside the test file.',
    args(y2) {
      declareCommonParams(y2);
      param(y2, ['out', 'o'], 'string',
        'Where to write the generated test file.'
        + 'By default the test file is written to stdout.');
      param(y2, ['sourcemap', 'm'], 'string',
        'Where to write the source map. '
        + 'Defaults to <out>.js.sourcemap');
    },
    handler(params) {
      const { '--': unparsed = [] } = params;
      assertCliParams(y, empty(unparsed), 'Parameters behind `--` are not supported');
      assertCliParams(y, !empty(params.source) || !empty(params.markdownSource),
        'Please specify at least --source or --markdown-source.');
    },
  });
};

/**
 * Parse arguments
 *
 * @function
 * @private
 * @param {...String} args CLI args without process/script name
 * @returns {Object} parsed Parameters as needed by the command being executed…
 * @returns {String} parsed._ Name of the command to execute.
 * @returns {String[]} parsed.unparsed The list of arguments behind `--`
 */
const parseArgs = (argv) => {
  const y = yargs();

  // First configure yargs
  y.strict();
  y.recommendCommands();
  y.parserConfiguration({
    'strip-dashed': true,
    'strip-aliased': true,
    'populate--': true,
  });

  // Configure console width if available
  if (console._stdout && console._stdout.columns) {
    y.wrap(console._stdout.columns);
  }

  // Configure Commands
  declareExecCmd(y);
  declareGenerateCmd(y);
  y.help();
  y.completion();

  // Parse args
  const {
    _: [command],
    '--': unparsed = [],
    // $0: executable,
    ...params
  } = y.parse(argv);

  assertCliParams(y, isdef(command), 'Please specify a command!');

  return { _: command, unparsed, ...params };
};

/**
 * Find the package.json used by cliExecute
 *
 * Given a directory, this will recursively search parent directories
 * until a package.json file is found, so this program will work in any
 * subdirectory of a node project.
 *
 * @function
 * @private
 * @param {String} pkg Either the path to package.json or a
 *   directory to search the package.json for.
 * @param {Object} opts
 * @param {Boolean} opts.tryParents Disable recursive parent search.
 *   If this is given the parameter must be the path of the package.json
 *   or the directory containing it.
 * @returns {[String, String]} 2-tuple; canonical path to the directory containing
 *   package.json; name of the package.
 */
const findPkg = async (pkg, opts = {}) => {
  const { tryParents = false } = opts;
  const p = path.resolve(pkg);

  // This is the package.json
  if ((await stat(p)).isFile()) {
    try {
      const { name } = JSON.parse(await readFile(p));
      assert(isdef(name), 'Name not set in package.json?');
      return [path.dirname(p), name];
    } catch (err) {
      err.__findPkgJsonFile = p;
      throw err;
    }
  }

  // This is a directory. Does it contain package.json?
  let err;
  try {
    return await findPkg(path.join(pkg, 'package.json'));
  } catch (e) {
    err = e;
  }

  // No package.json! Try finding one in the super dir?
  if (tryParents && err.code === 'ENOENT' && !isRoot(p)) {
    return findPkg(path.dirname(p), opts);
  }

  // Other error ocurred
  throw err;
};

/**
 * Implementation of the CLI generate command.
 *
 * @function
 * @private
 * @param {Object} params yargs parsed CLI params
 * @param {String} params.out Where to store the generated tests.
 *   If this is not specified, the tests will be written to stdout.
 * @param {String} params.shellCommand Path where to store the source map.
 *   Defaults to `${out}.map` if out is specified. If neither out nor map
 *   are specified, no source map will be written.
 * @param {String} params.template The template string to pass to squirrelly
 * @param {String[]} params.source List of files/directories to search for javascript source files
 * @param {String[]} params.markdownSource List of files/directories to search for markdown files
 * @returns {Number} The exit code
 */
const cliGenerate = async (params) => {
  const {
    out,
    sourcemap = isdef(out) ? `${out}.map` : out,
    ...rest
  } = params;

  // Do the Work
  let [testData, sourcemapData] = await generateTests(rest);

  if (isdef(out)) {
    sourcemapData._file = path.relative(path.dirname(sourcemap), out);
  }

  if (isdef(sourcemap)) {
    const relp = path.relative(path.dirname(out), sourcemap);
    testData += `\n//# sourceMappingURL=${relp}\n`;
  }

  // The rest is IO…
  const forks = [];

  // Write actual output
  if (isdef(out)) {
    forks.push(writeFile(out, testData));
  } else {
    console._stdout.write(testData);
  }

  // Write source map
  if (isdef(sourcemap)) {
    forks.push(writeFile(sourcemap, JSON.stringify(sourcemapData)));
  }

  // Make sure we only finish the promise once all files have
  // been written (this shouldn't even do anything due to the
  // page cache on linux)
  await Promise.all(forks);

  return 0;
};

/**
 * Implementation of the CLI execute command.
 *
 * @function
 * @private
 * @param {Object} params yargs parsed CLI params
 * @param {String} params.shellCommand Command; will be executed as shell code
 *   Behaviour is undefined if both argsCommand and shellCommand are given.
 * @param {String[]} params.argsCommand Command; will be execute directly (without passing
 *   through the shell). Behaviour is undefined if both argsCommand and shellCommand are given.
 * @param {String} params.package Path to the package.json or the directory containing it.
 *   If this is not given, the current directory and it's parents will be searched for
 *   a package.json.
 * @returns {Number} The exit code
 */
const cliExecute = async (params) => {
  const {
    shellCommand,
    argsCommand,
    package: pkg,
    ...generateOpts
  } = params;

  // Try to find the name of the package & it's location
  const [pkgDir, pkgName] = await exec(async () => {
    try {
      return isdef(pkg)
        ? await findPkg(pkg)
        : await findPkg('.', { tryParents: true });

    // Error while trying to find package.json
    } catch (er) {
      if (er.__findPkgJsonFile) {
        console.error(
          '[ERROR] Encountered exception while trying to parse package.json at',
          `${er.__findPkgJsonFile}: `, er,
        );
      } else {
        console.error(
          '[ERROR] Encountered exception while trying to find package.json: ', er,
        );
      }
      return exit(1);
    }
  });

  // Setup the temporary directory
  const tmp = mkTmpDir(`ferrum.doctest-${pkgName}`);

  // Provide the symlink to make `require('<pkg>')` possible
  await mkdir(`${tmp}/node_modules`);
  await symlink(pkgDir, `${tmp}/node_modules/${pkgName}`);
  env.NODE_PATH = transformStringList(env.NODE_PATH || '', ':',
    prepend(`${pkgDir}/node_modules`),
    prepend(`${tmp}/node_modules`));

  // Create the test file
  await cliGenerate({
    out: `${tmp}/examples.test.js`,
    ...generateOpts });
  env.DOCTEST_FILE = `${tmp}/examples.test.js`;

  // Run the command
  return onChildExit(
    isdef(shellCommand)
      ? systemShell(shellCommand)
      : system(argsCommand),
  );
};

/**
 * Main entry point
 *
 * @function
 * @private
 * @param {...String} args CLI args without process/script name
 * @returns {Number} The exit code
 */
const main = (...args) => {
  // This will also automatically process --help and completion
  const { _: command, ...params } = parseArgs(args);

  if (command === 'exec') {
    return cliExecute(params);
  } else if (command === 'generate') {
    return cliGenerate(params);
  }

  return unreachable();
};

/**
 * Handler for uncaught rejections/exceptions.
 * Terminates the process.
 * @function
 * @private
 */
const onUncaught = (e) => {
  console.error('[FATAL] Uncaught exception: ', e);
  exit(1);
};

/**
 * Initial entry point of the app…wrapper for main()
 * @function
 * @private
 */
const init = async () => {
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  process.on('SIGINT', () => exit(128));
  process.on('SIGTERM', () => exit(128));
  process.exitCode = (await main(...process.argv.slice(2))) || 0;
};

module.exports = {
  yargs,
  unreachable,
  isRoot,
  system,
  systemShell,
  onChildExit,
  liftArray,
  rmRecursiveSync,
  mkTmpDir,
  transformStringList,
  assertCliParams,
  cmd,
  param,
  pos,
  declareCommonParams,
  declareExecCmd,
  declareGenerateCmd,
  parseArgs,
  findPkg,
  cliGenerate,
  cliExecute,
  main,
};

if (require.main === module) {
  init();
}
