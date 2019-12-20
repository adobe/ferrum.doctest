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
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { v4: uuidgen } = require('uuid');
const { SourceMapGenerator } = require('source-map');
const { parse: parseMarkdown } = require('remark');
const { build: buildDoc } = require('documentation');
const {
  map, isdef, flattenTree, pipe, reject, concat, filter, join, get,
  group, enumerate, flat, curry, obj, list, takeDef, size,
  repeatFn, values,
} = require('ferrum');

const stat = promisify(fs.stat);
const readdir = promisify(fs.readdir);
const readFile = (file) => promisify(fs.readFile)(file, 'utf-8');

/**
 * Magic to require multiple instances of the same module.
 * Use for modules like squirrelly or yargs which are singletons.
 *
 * This works by temporarily removing the cached module from the
 * module cache and reinserting it after another require.
 *
 * ```js
 * const assert = require('assert');
 * const { type } = require('ferrum');
 * const { _requireNocache } = require('ferrum.doctest');
 *
 * const sq1 = require('squirrelly');
 * assert.strictEqual(type(sq1.Render), Function);
 *
 * const sq2 = _requireNocache('squirrelly');
 * assert.strictEqual(type(sq2.Render), Function);
 * assert.notStrictEqual(sq1, sq2);
 *
 * assert.strictEqual(sq1, require('squirrelly'));
 * ```
 *
 * @function
 * @private
 * @param {String} mod Name of the module to require
 * @returns {Module}
 */
const _requireNocache = (mod) => {
  const name = require.resolve(mod);
  const cache = require.cache[name];
  delete require.cache[name];
  // eslint-disable-next-line
  const r = require(name);
  delete require.cache[name];
  if (isdef(cache)) {
    require.cache[name] = cache;
  }
  return r;
};

/**
 * Magic function used to create multiple instances of the squirelly
 * module.
 *
 * Necessary because squirrelly is a singleton.
 *
 * This works by temporarily removing the cached module from the
 * module cache and reinserting it after another require.
 *
 * ```js
 * const assert = require('assert');
 * const { makeSquirrelly } = require('ferrum.doctest');
 *
 * assert.notStrictEqual(
 *   require('squirrelly'),
 *   makeSquirrelly('squirrelly')
 * );
 * ```
 *
 * @function
 */
const makeSquirrelly = () => {
  const Sqrl = _requireNocache('squirrelly');
  Sqrl.defineFilter('escapeLit', JSON.stringify);
  Sqrl.autoEscaping(false);
  return Sqrl;
};

/**
 * Format used to represent examples to be tested.
 *
 * Generally, the processing performed by ferrum.doctest can be divided
 * into two phases: Finding examples and rendering them to a testable file.
 *
 * The example format is used for communication between these two stages.
 *
 * ```notest
 * {
 *   name, // String; Unique, generated name of the example
 *   code, // String; The code in the example
 *   lang, // String; Optional language tag for the example
 *   file, // String; Path to the file containing the example
 *   line, // Integer; Line number of the example
 *
 *   // Non standard, optional properties
 *   doc, // Object; Documentation description object as generated
 *        //   by documentation.js (for findDocExamples)
 *   md,  // Object; mdast (if extracted from markdown)
 *
 *   // Third party non standard properties are permitted
 *   other....
 * }
 * ```
 *
 * @interface Message
 */

/**
 * Default template used for rendering test files.
 *
 * Suitable for testing with mocha.
 *
 * @constant
 * @sourcecode
 */
const defaultTemplate = `
describe('Documentation Examples', () => {
{{each(options.examples)}}

  it({{@this.name | escapeLit}}, async () => {
    const __filename = {{@this.file | escapeLit}};
    const __dirname = require('path').dirname({{@this.file | escapeLit}});

    {{@this.code}}
  });
{{/each}}
});`;

/**
 * Extract examples from a remark/mdast/unifiedjs AST.
 *
 * Basically just extracts a list of code blocks…
 *
 * See [extractFromMarkdown](#~extractFromMarkdown) for an example.
 *
 * @function
 * @see extractFromMarkdown
 * @param {Mdast} ast The ast to extract the code blocks from.
 * @param {Object} opts
 * @param {String} opts.file Name of the file the ast is from…
 *   Defaults to null. This *must* be specified for `generatingSourceMap()`
 *   to work down the road…
 * @returns {Sequence<Example>}
 */
const extractFromMdast = (ast, opts = {}) => {
  const { file = null } = opts;
  return pipe(
    flattenTree(ast, (node, rec) =>
        concat([node], rec(node.children || []))),
    filter(({ type }) => type === 'code'),
    enumerate,
    map(([idx, md]) => {
      const { value: code, lang, position: pos } = md;

      const name = `${file && path.basename(file)} #${idx}`;

      // For fenced code blocks the fences count towards the line numbers
      // in pos…we need to correct for this
      const codeLineCount = code.match(/(^|\n)/g).length;
      const posLineCount = (pos.end.line - pos.start.line) + 1;
      const isFenced = codeLineCount !== posLineCount;
      const line = pos.start.line + (isFenced ? 1 : 0);

      return { line, code, lang, file, md, name };
    }),
  );
};

/**
 * Extract examples from markdown. Pretty much just a small wrapper
 * around `extractFromMdast()`.
 *
 * Basically just extracts a list of code blocks…
 *
 * ```js
 * const { assertSequenceEquals, pipe, multiline, map } = require('ferrum');
 * const { extractFromMarkdown } = require('ferrum.doctest');
 *
 * const md = multiline(`
 *   # Hello World
 *
 *   This is a text
 *
 *   \`\`\`js
 *   Example no 1
 *   Second line
 *   \`\`\`
 *
 *   Another test
 *
 *       Example no 2
 *
 * `);
 *
 * assertSequenceEquals(
 *   pipe(
 *     extractFromMarkdown(md, { file: 'anon_file' }),
 *     // Delete the `md` (markdown ast) property from the examples
 *     // (It's a bit much to test)
 *     map(({md, ...obj}) => obj)),
 *   [
 *     { code: 'Example no 1\nSecond line', line: 6, lang: 'js', file: 'anon_file', name: 'anon_file #0' },
 *     { code: 'Example no 2', line: 12, lang: null, file: 'anon_file', name: 'anon_file #1' }
 *   ]
 * );
 * ```
 *
 * @function
 * @sourcecode
 * @param {String} text The markdown content to extract the code blocks from.
 * @param {Object} opts
 * @param {String} opts.file Name of the file the ast is from…
 *   Defaults to null. This *must* be specified for `generatingSourceMap()`
 *   to work down the road…
 * @returns {Sequence<Example>}
 */
const extractFromMarkdown = (text, opts = {}) =>
  extractFromMdast(parseMarkdown(text), opts);

const _extractFromDocImpl = function* (doc) {
  const line0 = doc.loc.start.line;
  const { file } = doc.context;

  let descLine0 = line0;
  for (const { title, description: code, lineNumber: line } of doc.tags) {
    if (title === 'example') {
      // NOTE: The line will be off by one (+1) for example tags with content
      // starting on the same lines as the tag…
      // There is no way to solve this with the current state of documentation.js
      // short of opening the file and checking manually (which we might need to
      // do). This and other design flaws call the entire design of using documentation.js
      // to generate an AST…it simply does not provide what we need…
      yield {
        code, lang: null, file, line: line + line0 + 1, doc,
      };
    } else if (title === 'description') {
      descLine0 += line;
    }
  }

  yield* pipe(
    extractFromMdast(doc.description, { file }),
    map(({line, ...fields}) => ({
      line: line + descLine0,
      doc,
      ...fields,
    })),
  );
};

/**
 * Extract examples from a single documentation description as
 * generated by `documentation.js`.
 *
 * Extracts from @example tags as well as code blocks inside the
 * description.
 *
 * See [findDocExamples](#~findDocExamples) for an example of how to use this.
 *
 * @function
 * @param {Object} doc The documentation to extract the examples from.
 * @returns {Sequence<Example>}
 */
const extractFromDoc = (doc) => pipe(
  _extractFromDocImpl(doc),

  // Assign a counter to each example
  group(({ fileName, docPath }) => `${fileName} ${docPath}`),
  values,
  map(enumerate),
  flat,

  // Calculate the example name
  map(([idx, example]) => ({
    ...example,
    name: `${path.basename(example.file)} ${join(map(example.doc.path, get('name')), '::')} #${idx}`,
  })),
);

/**
 * Find and extract examples from a list of files or directories.
 *
 * This will use documentation.js to parse the documentation from
 * the given files/dirs and then apply extractFromDoc.
 *
 * ```notest
 * /**
 *  * ```hello,world
 *  * console.log("Example 1");
 *  * ```
 *  *
 *  * @example
 *  * console.log("Example 2");
 *  * /
 * const fn1 = () => null;
 * ```
 *
 * ```notest
 * const { findDocExamples } = require('ferrum.doctest');
 *
 * // The actual order of the output is undefined, so we need to sort it
 * const sorter = mapSort(({name}) => name);
 * const main = async () => assertSequenceEquals(
 *   sorter(await myfindDocExamples([`my/path/mysource.js`])),
 *   sorter([
 *     {
 *       code: "console.log(\"Example 1\");",
 *       lang: 'hello,world',
 *       line: 3,
 *       name: 'mysource.js fn1 #0',
 *       file: `my/path/mysource.js`,
 *       doc: {
 *          ...documentation object
 *       }
 *     },
 *     {
 *       code: "console.log(\"Example 2\");",
 *       lang: null,
 *       line: 3,
 *       name: 'mysource.js fn1 #1',
 *       file: `my/path/mysource.js`,
 *       doc: {
 *          ...documentation object
 *       }
 *     },
 *   ])
 * );
 * ```
 *
 * @function
 * @sourcecode
 * @param {String[]} path The list of paths to search source files in
 * @returns {Sequence<Example>}
 */
const findDocExamples = async (paths) => pipe(
  await buildDoc(paths, {
    access: ['public', 'protected', 'private', 'undefined'],
  }), // Defer to documentation.js
  map(extractFromDoc), // Extract documentation examples
  flat,
);

/**
 * Recursively list the contents of the directory, including the directory
 * itself.
 *
 * ```
 * const { assertSequenceEquals } = require('ferrum');
 * const { _findFs } = require('ferrum.doctest');
 *
 * assertSequenceEquals(
 *   await _findFs('test/fixtures', (path, ent) => !ent.isDirectory()),
 *   [
 *     'test/fixtures/dummy1.js',
 *     'test/fixtures/dummy2.js',
 *     'test/fixtures/dummy3.md',
 *     'test/fixtures/out.js',
 *     'test/fixtures/out.js.map.sqrl',
 *     'test/fixtures/out.js_examples.json.sqrl',
 *     'test/fixtures/out.md_examples.json.sqrl'
 *   ]);
 * ```
 *
 * @function
 * @param {String} path
 * @param {Function} fn The filter function; decides
 * @returns {Promise<Dirent[]>}
 */
const _findFs = async (p, fn=() => true, _ent=undefined) => {
  const ent = isdef(_ent) ? _ent : await stat(p);

  const forks = !ent.isDirectory() ? []
    : map(await readdir(p, { withFileTypes: true }), (sub) =>
      _findFs(path.join(p, sub.name), fn, sub));
  const children = flat(await Promise.all(forks))

  return fn(p, ent) ? concat([p], children) : children;
};


/**
 * Find and extract examples from a list of markdown files or
 * directories containing them.
 *
 * This will recursively search for files with the `.md` suffix
 * and then us extractFromMarkdown to extract the example.
 *
 * For examples of what this outputs please see [extractFromMarkdown](#~extractFromMarkdown).
 *
 * @function
 * @see extractFromMarkdown
 * @param {String[]} path The list of paths to search markdown files in.
 * @returns {Sequence<Example>}
 */
const findMarkdownExamples = async (paths) => {
  const _paths = pipe(
    paths,
    map(path.resolve),
    map((p) => _findFs(p, (p_, ent) =>
      ent.isFile() && path.extname(p_) === '.md')));

  const extracted = pipe(
    // List all files in the paths
    await Promise.all(_paths),
    flat,

    // Read all files from
    map((file) => readFile(file).then((md) =>
        extractFromMarkdown(md, { file }))),
  );

  return flat(await Promise.all(extracted));
};

/**
 * This helper performs some sophisticated magic so source maps
 * can be generated with arbitrary template renderers.
 *
 * See the [generateTests](#~generateTests) source for an example of how to use this.
 *
 * This function is auto-curried.
 *
 * # Caveats
 *
 * This process comes with some caveats, so please read this documentation
 * carefully; summarized quickly, you cannot transform the code in any way
 * for this to work properly either during rendering or during the preprocessing
 * stages. You must paste it exactly as it was encountered in the source file.
 * indenting the code is explicitly permitted.
 *
 * # How it works
 *
 * In order to properly generate a source map, inserting the code and generating
 * the source map must be done at the same time…
 *
 * In order to make it possible to generate source maps while using all sorts
 * of renderers, a trick is used: This function assigns a UUID to each example
 * and replaces the code with that example as a pre processing step.
 *
 * This way, your renderer inserts the uuid instead of the actual code.
 *
 * During post processing, the function looks for all those uuids in the rendered
 * tests and replaces them with the original code. This way it automatically
 * knows the correct line number and indentation.
 *
 * Since the examples list does not contain information about the column in
 * the input file (documentation.js actually doesn't output that information properly)
 * we recover the information by actually reading the original source file and looking
 * up the indentation/column line by line.
 *
 * @function
 * @see generateTests
 * @param {Sequence<Example>} examples
 * @param {Function} renderer. Takes the list of examples, renders the
 *   examples into a test file and returns the render as a string.
 * @returns {[String, SourceMap]} 2-tuple containing: The fully compiled
 *   test source code (as returned by your renderer). The Source Map object
 *   (as specified by mozilla's source-map library). Can be serialized using
 *   `JSON.stringify(...)`
 */
const generatingSourceMap = curry('generatingSourceMap', async (examples, renderer) => {
  // Generate Example Cache
  const exampleCache = pipe(
    examples,
    map((example) => [uuidgen(), example]),
    obj,
  );

  // Pre process examples
  const examples2 = pipe(
    exampleCache,
    map(([id, example]) => ({
      ...example,
      code: `<<example:${id}>>`,
    })),
    list);

  // Run renderer function
  const gen = renderer(examples2);

  // POST PROCESSING

  const sourceCache = {};
  const loadSourceFile = async (file) => {
    if (!(file in sourceCache)) {
      sourceCache[file] = (await readFile(file)).split('\n');
    }

    return sourceCache[file];
  };

  // Parsing rendered data/searching code embeds
  const re = /([ \t]*)<<example:([0-f]{8}-[0-f]{4}-[0-f]{4}-[0-f]{4}-[0-f]{12})>>/mg;
  const matches = takeDef(repeatFn(() => re.exec(gen)));

  const sourceMap = new SourceMapGenerator();
  const buf = [];

  let lastMatchEnd = 0;
  let outLineNo = 0; // line number starts at zero
  for (const { 0: match, 1: outIndent, 2: uuid, index } of matches) {

    // Process the chunk of text before the code embed…
    const previousText = gen.slice(lastMatchEnd, index);
    buf.push(previousText);

    outLineNo += size(previousText.match(/\n/g));
    lastMatchEnd = index + size(match); // end of match

    // Rare edge case where the actually generated code
    // contains data in the format `<<example:UUID>>`
    if (!(uuid in exampleCache)) {
      buf.push(match);
      // Source file loading
      continue;
    }

    // Process code embed
    let { code, file, line: inLineNo } = exampleCache[uuid]; // line number starts at 1
    const outColumn = size(outIndent);
    for (const line of code.split('\n')) {
      // Output indented code
      buf.push(outIndent);
      buf.push(line);
      buf.push('\n');

      // Update source map
      sourceMap.addMapping({
        source: file,
        original: {
          // The input line should end with the code we get; so we can
          // calculate the column by subtracting the code length from
          // the input line length
          column: size((await loadSourceFile(file))[inLineNo - 1]) - size(line),
          line: inLineNo,
        },
        generated: {
          line: outLineNo + 1,
          column: outColumn,
        },
      });

      outLineNo += 1;
      inLineNo += 1;
    }
  }

  // Last bit of generated code
  buf.push(gen.slice(lastMatchEnd));

  return [join(buf, ''), sourceMap];
});

/**
 * Generate the test code and the source map.
 *
 * This is the pretty much the `$ ferrum.doctest generate` cli command,
 * without writing the files to disk.
 *
 * This contains only very high level glue code, no complex implementation
 * details. If you wish to customize how ferrum.doctest operates, you may
 * use this function as a template & copy it. The source is very well documented
 * to facilitate this.
 *
 * Use like this:
 *
 * ```
 * const path = require('path');
 * const fs = require('fs');
 * const { promisify } = require('util');
 * const { assertEquals, pipe } = require('ferrum');
 * const { generateTests, makeSquirrelly } = require('ferrum.doctest');
 *
 * const readFile = (file) => promisify(fs.readFile)(file, 'utf-8');
 * const writeFile = promisify(fs.writeFile);
 *
 * const dir = `${__dirname}/test/fixtures`;
 * const jsFile = `${dir}/out.js`;
 * const mapFile = `${jsFile}.map`;
 *
 * // This is the actual call to generateTests; the rest around
 * // it is just making extra IO happen
 * let [sourceCode, sourceMap] = await generateTests({
 *   source: [dir],
 *   markdownSource: [dir],
 * });
 *
 * // Add cross references between code & source map so tools
 * // can find the map/code from each other
 * sourceMap._file = path.basename(jsFile);
 * // Place at the bottom to avoid invalidating the source map
 * sourceCode += `\n//# sourceMappingURL=${path.basename(mapFile)}\n`;
 *
 * // Write to disk
 * // await Promise.all(
 * //   writeFile(jsFile, sourceCode),
 * //   writeFile(mapFile, JSON.stringify(sourceMap));
 *
 * // For the purpose of testing we do the opposite: Load the files
 * // from disk and compare with our results
 * const [expectedCode, expectedMap] = await Promise.all([
 *   readFile(jsFile),
 *   readFile(`${mapFile}.sqrl`)]);
 *
 * assertEquals(sourceCode, expectedCode);
 * assertEquals(
 *   sourceMap.toJSON(),
 *   // Handle absolute paths in the reference document
 *   pipe(
 *     expectedMap,
 *     (tmpl) => makeSquirrelly().Render(tmpl, { test_dir: __dirname + '/test' }),
 *     JSON.parse));
 * ```
 *
 * @function
 * @sourcecode
 * @param {Object} opts
 * @param {String} opts.template The template string to pass to
 *   squirrelly. Defaults to defaultTemplate.
 * @param {String[]} opts.source List of files/directories to search for javascript source files
 * @param {String[]} opts.markdownSource List of files/directories to search for markdown files
 * @returns {[String, SourceMap]} 2-tuple containing: The fully compiled
 *   test source code. The Source Map object (as specified by mozilla's
 *   source-map library). Can be serialized using `JSON.stringify(...)`
 */
const generateTests = async (opts) => {
  const { template = defaultTemplate, source, markdownSource } = opts;
  // We are using the ferrum.js pipeline feature here to model a
  // multi step processing pipeline.
  // Checkout https://www.ferrumjs.org to find many of it's useful functions
  // like `map()`, `filter()` and many others.
  return pipe(
    // The first step is called a 'source'; it doesn't take a sequence as
    // input but produces one
    concat(
      // This is what actually finds and parses the documentation.
      // You could replace this or add another example finder to
      // hook into other documentation systems.
      await findDocExamples(source),
      // This is what searches for markdown files and extracts it's
      // examples
      await findMarkdownExamples(markdownSource),
    ),

    // At this point in the pipeline, we have a sequence of example-objects
    //
    // {
    //   name, // Unique, generated name of the example
    //   code, // The code in the example
    //   lang, // Optional language tag for the example
    //   file, // Path to the file containing the example
    //   line, // Line number of the example
    //
    //   // Non standard, optional properties
    //   doc, // Documentation description object as generated
    //        //   by documentation.js (for findDocxamples)
    //   md,  // mdast (if extracted from markdown)
    // }
    //
    // Now it's time to transform the list of examples!
    // By default we do not do anything fancy; we just remove examples
    // marked as `notest` in the language tag; you could change this to
    // for example to only include examples marked as `tested` in the language
    // tag.

    reject(({ lang }) => isdef(lang) && lang.match('notest')),

    // Finally we have a so called `sink` in our processing pipeline;
    // a step that consumes the entire sequence and does something
    // useful with it!

    // Function from ferrum, equivalent to Array.from; enable this if
    // you remove the source map generation feature; generatingSourceMap
    // can handle a sequence/iterable; your template engine may not
    // list,

    // generatingSourceMap performs some tricky magic to make it
    // possible to generate source maps with arbitrary renderers
    generatingSourceMap((examples) =>
    // This is where the actual rendering happens. See the
    // squirrelly documentation!
      makeSquirrelly().Render(template, {
        // Your custom squirrelly variables go here!
        examples,
      })),
  );
};

module.exports = {
  _requireNocache,
  _findFs,
  makeSquirrelly,
  defaultTemplate,
  extractFromMdast,
  extractFromMarkdown,
  extractFromDoc,
  findDocExamples,
  findMarkdownExamples,
  generatingSourceMap,
  generateTests,
};
