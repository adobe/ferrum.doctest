<a name="ferrum"></a>
# Ferrum Doctest

Ferrum.doctest allows you to test examples included in your documentation.

Did you every try an example from a project just to notice that it contains a syntax error?
Did you ever avoid writing examples because it is extra work and you basically wrote the same code in your tests?

This is what ferrum.doctest is designed to solve! It parses your source code, extracts all the examples from your
jsdoc and generates a file that can be executed with your test framework!

## Using it

Install it:

```shell,notest
$ npm install --only-dev ferrum.doctest
```

And execute your tests:

```shell,notest
$ npx ferrum.doctest exec \
  -s src/ --mdsrc README.md \
  -c 'mocha --require source-map-support/register \"$DOCTEST_FILE\" test/'
```

The `-s` and `--mdsrc` indicate which source files/directories to scan for examples.
The `-c` indicates your command to invoke tests. `"$DOCTEST_FILE"` is a variable indicating
the location of the generated tests.

ferrum.doctest also features a `generate` command which just generates the tests without
execting any actual tests. Invoke `$ ferrum.doctest help` for more information.

## Selectively disabling tests

You can use the `notest` tag on code blocks inside markdown to disable
testing that particular block

~~~notest
```notest
This will not be tested.
```
~~~

## Other testing frameworks

You will have to provide a test file template for your particular testing framework.

```notest
$ npx ferrum.doctest exec \
  -t ./myJasmineTemplate.js.sqrl \
  -s src/ --mdsrc README.md \
  -c 'jasmine ...'
```

See `defaultTemplate` inside [index.js](./blob/master/index.js).

## Stack Traces/Source Maps

Ferrum.doctest automatically generates source maps. We use the [source-map-support](https://github.com/evanw/node-source-map-support)
package to add support for them while testing.

Note that the mocha example above already provides support for source maps!

Unfortunately source maps currently do not work for syntax errors, but support
for syntax errors is planned.

## Using from javascript

Ferrum.doctest has an extensive api documentation. See [index.js](./blob/master/index.js)
and the `generateTests()` function in particular.

<a name="build"></a>
### Build

```bash,notest
$ npm install
```

<a name="test"></a>
### Test

```bash,notest
$ npm test
```

<a name="lint"></a>
### Lint

```bash,notest
$ npm run lint
```
