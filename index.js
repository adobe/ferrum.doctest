#! /usr/bin/env node
const { argv, exit } = require('process');
const { basename } = require('path');
const { v4: uuidgen } = require('uuid');
const { SourceMapGenerator } = require('source-map');
const {
  flat, map, isdef, iter, each, flattenTree, pipe, reject, concat,
  filter, join, get,
} = require('ferrum');

const defaultTemplate = `
  describe('Documentation Examples', () => {
    {{each(examples)}}
      it('{{@this.exampleName}}', () => {
        {{@this.code}}
      });
    {{/foreach}}
  });`;

const _requireNocache = (mod) => {
  const name = require.resolve(mod);
  const cache = require.cache[name];
  delete require.cache[name];
  const r = require(name);
  delete require.cache[name];
  if (isdef(cache)) {
    require.cache[name] = cache;
  }
  return r;
}

const makeSquirrelly = () => requireNocache('squirrelly');

const extractMdCodeBlocks = (md) => pipe(
  flattenTree(md, (node, rec) =>
      concat([node], rec(node.children || []))),
  filter(({type}) => type === 'code'),
  map(({value, lang, position: pos}) =>
      [value, lang, pos.start.line]));

const extractOneDocExamples_ = function*(doc) {
  const line0 = doc.loc.start.line;
  const file = doc.context.file;

  let descLine0 = line0;
  for (const {title, description: code, lineNumber: line} of doc.tags) {
    if (title === 'example') {
      yield {code, lang: null, file, line: line + line0, doc};
    } else if (title === 'description') {
      descLine0 += line;
    }
  }

  yield* pipe(
    extractMdCodeBlocks(doc.description),
    map(([code, lang, line]) => ({
        code, lang, line: line+descLine0, doc
    })));
};

const extractOneDocExamples = (doc) => pipe(
  extractOneDocExamples_(doc),
  // Calculate extra properties
  map(example) => ({
    ...example,
    filePath: example.doc.context.file,
    fileName: example.doc.context.file.match(/[^/]*(?=\.[^./]*$)/),
    docPath: join(map(example.doc.path, get('name')), '::'),
  })),

  // Add example index & calculate example name
  group(({fileName, docPath}) => `${fileName} ${docPath}`),
  map(enumerate),
  map(([idx, example]) => ({
    ...example,
    exampleIndex: idx
    exampleName: `${example.fileName} ${example.docPath} #${idx}`
  }))
);

const extractExamples = (doc) => flat(map(doc, extractOneDocExamples));

const renderExamples = ({fields, template=defaultTemplate, Sqrl=makeSquirrelly()}) =>
    Sqrt.Render(template, fields);

const generatingSourceMapImpl_ = (examples, renderer) => {
  // Generate Example Cache
  const exampleCache = pipe(
    fields.examples,
    map((example) => [uuidgen(), example]),
    obj
  );

  // Pre process examples
  const examples2 = pipe(
    examples,
    map(([id, example]) => ({
      ...example,
      code: `<<example:${id}>>`
    })),
    list
  );

  // Run renderer function
  const gen = renderer({
    ...fields,
    examples: examples2
  });

  // POST PROCESSING

  // Source file loading
  const sourceCache = {};
  const loadSourceFile = (file) => {
    if (!(file in sourceCache)) {
      sourceCache[file] = readFileSync(file).split('\n');
    }

    return sourceCache[file];
  };

  // Parsing rendered data/searching code embeds
  const re = /^(\s*)<<example:([0-f]{8}-[0-f]{4}-[0-f]{4}-[0-f]{4}-[0-f]{12})>>/mg;
  const matches = takeDef(repeatFn(() => re.exec(gen)));

  const sourceMap = new SourceMapGenerator();

  let lastMatchEnd = 0, outLineNo = 0; // line number starts at zero
  for (const {0: match, 2: outIndent, 1: uuid, index} of matches) {
    // Process the chunk of text before the code embed…
    const previousText = gen.slice(lastMatchEnd, index);
    yield previousText;
    outLineNo += size(previousText.match(/\n/g));
    lastMatchEnd = index + size(match); // end of match

    // Rare edge case where the actually generated code
    // contains data in the format `<<example:UUID>>`
    if (!(uuid in exampleCache)) {
      yield match;
      continue;
    }

    // Process code embed
    const { code, file, line: inLineNo } = exampleCache[uuid]; // line number starts at 1
    const outColumn = size(outIndent);
    for (const line of .split('\n')) {
      // Output indented code
      yield indent;
      yield line;
      yield '\n';

      // Update source map
      sourceMap.addMapping({
        source: file,
        original: {
          line: inLineNo,
          // The input line should end with the code we get; so we can
          // calculate the column by subtracting the code length from
          // the input line length
          column: size(loadSourceFile(file)[inLineNo - 1]) - size(line),
        },
        generated: {
          line: outLineNo + 1
          column: outColumn
        }
      });
    }
  }

  // Last bit of generated code
  yield gen.slice(lastIdx);

  // Output source map
  yield sourceMap;
};

const generateTestFile = (opts) => {
  const {template = defaultTemplate, source, markdownSource} = opts;
  return pipe(
    concat(
        findDocumentationExamples(source),
        findMarkdownExamples(markdownSource)),
    reject(({lang}) =>
        isdef(lang) && lang.match('noexec'))
    generatingSourceMap((examples) =>
        makeSquirrelly().render(template, { examples })));
}

module.exports = {
  defaultTemplate,
  _requireNocache,
  makeSquirrelly,
  extractExamples,
  renderExamples,
  generatingSourceMap
};
