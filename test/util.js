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

const assert = require('assert');
const { AssertionError } = require('assert');
const { typename, type } = require('ferrum');

const ckThrows = async (cls, fn) => {
  let err;
  try {
    await fn();
    throw AssertionError({ message: 'Function should have thrown.' });
  } catch (e) {
    err = e;
  }
  assert(err instanceof cls, `Error (${typename(type(err))}) should be an instance of ${typename(cls)}.`);
  return err;
};

module.exports = { ckThrows };
