const fs = require('fs');
const { spawn } = require('child_process');
const { tmpdir } = require('os');
const { promisify } = require('util');
const { exit, argv } = require('process');
const { uuid4: uuid } = require('uuid');
const { build: parseDoc } = require('documentation');
const { type, isdef, each, xnor, pipe, prepend } = require('ferrum');
const {
  _requireNocache,
  defaultTemplate,
  cliGenerate,
  cliExecute,
} = require('./');

// Down with singletons!
const yargs = () => _requireNocache('yargs');

const readFileSync = (file) => fs.readFileSync(file, 'utf-8');
const readFile = (file) => promisify(fs.readFile)(file, 'utf-8');
const writeFile = promisify(fs.writeFile);
const stat = promisify(fs.stat);
const mkdir = promisify(fs.mkdir);
const symlink = promisify(fs.symlink);

const unreachable = () => {
  console.error('[FATAL] Executing unreachable code! This should not happen.');
  exit(1);
};

// Test if a path is at the root of the file system
const isRoot = (p) => {
  // Note: Using this slightly convoluted method for portability
  const p_ = path.normalize(p);
  return path.dirname(p_) == p;
};

// Execute a system command
const system = (cmd, opts) => {
  const [command, ...args] = cmd;
  return spawn(command, args, {
    stdio: ['inherit', 'inherit', 'inherit'],
    ...opts
  });
};

// Execute a system command with a shell
const systemShell = (shellCode, opts) =>
    system([shellCode], { shell: true, ...opts });

// Wait until a child process exits
const onChildExit = (child) => new Promise((res) =>
    child.on('exit', (code) =>
        res(code)));

// Ensure that the given parameter is an array
const liftArray = (v) => type(v) === Array ? v : [v];

// Transform a string encoded list
const transformStringList = (str, divider, ...fns) => pipe(
  empty(str) ? [] : str.split(divider),
  ...fns
  join(divider));

// Helper for defining commands
const cmd = (y, names, { description, args, handler, usage}) => {
  const args_ = (y2) => {
    if (isdef(usage)) {
      y2.usage(usage);
    }
    args(y2);
  };
  y.command(names, description, args_, handler);
};

const assertCliParams = (v, msg) => {
  if (!v) {
    yargs.printHelp();
    console.error(msg);
    yargs.exit(1);
  }
};

// Helper for defining a parameter/option with an argument
const param = (y, names, typ = 'string', description, opts = {}) => {
  if (type(description) === Object) {
    return param(y, names, typ, undefined, description);
  }

  const [name, ...alias] = liftArray(names);
  y.option(name, {
    alias,
    type: typ,
    description,
    nargs: 1,
    requiresArg: true,
    ...opts
  });
};

// Helper for defining a positional argument
const pos = (y, name, type, description, opts={}) =>
    y.positional(name, { type, description, opts });

// Helper used by multiple commands to define common options
const declareCommonParams = (y) => {
  param(y, ['template', 't'], 'string', {
    default: null,
    coerce: (file) => isdef(file) ? readFileSync(file) : defaultTemplate,
    description: 'Path of the template to use when generating the test file.',
  });

  param(y, ['source', 'src', 's'], 'string', {
    coerce: liftArray,
    default: [],
    description:
      'The file or directory to search for javascript files with examples. ' +
      'Can be specified multiple times.',
  });

  param(y, ['markdown-source', 'mdsrc'], 'string', {
    coerce: liftArray,
    default: [],
    description:
      'The file or directory to search for markdown files with examples. ' +
      'Can be specified multiple times.',
  });
};

const declareEnvCmd = (y) => {
  cmd(y, 'exec [argsCommand...]', {
    usage:
      '$0 generate [-t TEMPLATE] [-s JS_SOURCE]... [--mdsrc MD_SOURCE]... [-c SHELL_CODE|COMMAND... [-- COMMAND...]]',
    description:
      'Like the generate command, this will search for examples in the given ' +
        'markdown & javascript files/directories and use them to generate' +
        'a test file & an associated source map.\n' +
      '\n' +
      'Unline generate this command will automatically choose a temporary ' +
        'directory to put the test file and source map in and delete the directory ' +
        'after the tests have finished.\n' +
      '\n' +
      'This will also make `require(\'<yourpackage>\')` calls work by automatically ' +
        'generating a node_modules folder in the temporary directory and adding a symlink ' +
        'to the package you are developing.',
    args(y2) {
      declareCommonParams(y2);
      pos(y2, 'command', 'string',
          'The command and arguments to execute within the created environment. ' +
            'Use the -- separator if you need to specify options.')
      param(y2, ['package', 'p'], 'string', {
        description:
          'The location of the package.json for which an alias should be generated.\n' +
          '\n' +
          'Usually the location is automatically detected based on your current directory.'
      });
      param(y2, ['command', 'c'], 'string', {
        description:
          'The location of the package.json for which an alias should be generated.\n' +
          '\n' +
          'Usually the location is automatically detected based on your current directory.'
      });
    },

    handler(params) {
      const { argsCommand, '--': unparsed, command: shellCommand } = params;

      argsCommand.push(unparsed);
      delete params['--'];
      params.shellCommand = shellCommand;
      delete params.command;

      assertCliParams(xor(!empty(argsCommand), isdef(shellCommand))
          'Please specify a command either in the arguments or with -c.');
    }
  });
};

const declareGenerateCmd = (y) => {
  cmd(y, 'generate', {
    usage:
      '$0 generate [-t TEMPLATE] [-s JS_SOURCE]... [--mdsrc MD_SOURCE]... [-o FILE] [-m MAP_FILE]',
    description:
      'Generate a test file from the given examples.\n' +
      '\n' +
      'This will iterate over all the files/directories containing ' +
        'javascript/markdown files and extract the examples. ' +
        'These will be passed through the given template to generate ' +
        'test files suitable for use with your test runner.\n' +
      '\n' +
      'A souce map file will also be generated alongside the test file.',
    args(y2) {
      declareCommonParams(y2);
      param(y2, ['out', 'o'], 'string',
        'Where to write the generated test file.' +
        'By default the test file is written to stdout.');
      param(y2, ['sourcemap', 'm'], 'string',
        'Where to write the source map. ' +
        'Defaults to <out>.js.sourcemap');
    },
    handler(params) {
      const { '--': unparsed } = params;
      assertCliParams(empty(unparsed), 'Parameters behind `--` are not supported');
    }
  });
};

const parseArgs = (y, rawArgs) => {
  const y = yargs();

  // First configure yargs
  y.strict();
  y.recommendCommands();
  y.parserConfiguration({
    'strip-dashed': true,
    'strip-aliased': true,
    'populate--': true
  });

  // Configure console width if available
  if (console._stdout && console._stdout.columns) {
    y.wrap(console._stdout.columns);
  }

  // Configure Commands
  declareEnvCmd(y);
  declareGenerateCmd(y);
  y.help();
  y.completion();

  // Parse args
  const {
    _: [command, /* ...never set */],
    '--': unparsed = [],
    '$0': executable,
    ...params
  } = y.parse(rawArgs);

  return {_: command, unparsed, ...params};
};

// Given a path determine [pathToPackageDir, packageName]
const findPkg = async (pkg, opts = {}) => {
  const { tryParents = false } = opts;
  const p = path.normalize(pkg);

  // This is the package.json
  if ((await stat(p)).isFile()) {
    try {
      const {name} = JSON.parse(await readFile(p));
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
    return await findPkg(path.join(pkg, 'package.json');
  } catch (e) {
    err = e;
  }

  // No package.json! Try finding one in the super dir?
  if (tryParents && err.code == 'ENOENT' && !isRoot(p)) {
    return findPkg(path.dirname(p), opts);
  }

  // Other error ocurred
  throw err;
};


const cliGenerate = async (params) => {
  const {
    sourcemap = isdef(out) ? `${out}.map` : out,
    out,
    ...rest
  } = params;

  // Do the Work
  const [testData, sourcemapData] = await generateTestFile(rest);

  // The rest is IO…
  const forks = [];

  if (isdef(sourcemap)) {
    forks.push(
        writeFile(sourcemap, sourcemapData));
  }

  if (isdef(out)) {
    forks.push(
        writeFile(out, testData));
  } else {
    console._stdout.write(testData);
  }

  // Make sure we only finish the promise once all files have
  // been written (this shouldn't even do anything due to the
  // page cache on linux)
  await Promise.all(forks);

  return 0;
};
const cliExecute = async () => {
  const {
    unparsed,
    shellCommand,
    argsCommand,
    package: pkg,
    ...generateOpts
  } = req;

  // Try to find the name of the package & it's location
  const [pkgDir, pkgName] = exec(() => {
    try {
      return  isdef(pkg)
        ? await findPkg(pkg)
        : await findPkg('.', { tryParents: true }));

    // Error while trying to find package.json
    } catch (er) {
      yargs.printHelp();
      if (er.__findPkgJsonFile) {
        console.error(
          "[ERROR] Encountered exception while trying to parse package.json at",
          `${er.__findPkgJsonFile}: `, er);
      } else {
        console.error(
          "[ERROR] Encountered exception while trying to find package.json: ", er);
      }
      exit(1);
    }
  });

  // Setup the temporary directory
  const tmp = `${tmpdir()}/${pkgName}-ferrum.doctest-${uuid}`;
  await mkdir(tmp);

  // Provide the symlink to make `require('<pkg>')` possible
  await mkdir(`${tmp}/node_modules`);
  await symlink(`${tmp}/node_modules/${pkgName}`, pkgDir);
  env.NODE_PATH = transformStrList(env.NODE_PATH, ':',
      prepend(`${tmp}/node_modules`));

  // Create the test file
  const r = await cliGenerate({
    out: `${tmp}/node_modules/examples.test.js`,
    ...generateOpts});
  if (isdef(r) && r !== 0) {
    return r;
  }

  // Run the command
  return onChildExit(
      isdef(shellCommand)
          ? systemShell(shellCommand)
          : system(argsCommand));
};

const main = (...rawArgs) => {
  // This will also automatically process --help and completion
  const {_: command, ...params} = parseArgs(yargs, rawArgs);

  if (command === 'exec') {
    return cliGenerate(params);
  } else (command === 'generate') {
    return cliExecute(params);
  }

  unreachable();
};

// Initial entry point of the app…handles exceptions
const init = async () => {
  try {
    exit(await main(...argv.slice(2)) || 0);
  } catch (e) {
    console.error("[FATAL] Uncaught exception: ", e);
    exit(1);
  }
};

init();
