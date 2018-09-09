const crypto = require('crypto');
const electron = require('electron');
const path = require('path');

const fs = require('graceful-fs');
const keyPathHelpers = require('key-path-helpers');
const mkdirp = require('mkdirp');
const writeFileAtomic = require('write-file-atomic');

const defaults = require('./defaults');

/**
 * A key path is the string equivalent of dot notation in
 * JavaScript. Take the following object, for example:
 *
 *   ```
 *   const obj = {
 *     foo: {
 *       bar: 'baz'
 *     }
 *   };
 *   ```
 *
 * You can access the value of the key "bar" in plain
 * JavaScript by traversing the tree using object dot
 * notation, like so:
 *
 *   ```
 *   console.log(obj.foo.bar);
 *   // => "baz"
 *  ```
 *
 * Similarly in Electron Settings, you are reading and
 * writing to a JSON object in a file, and a key path is
 * just a string that points to a specific key within that
 * object -- essentially using object dot notation in
 * string form.
 *
 * Key paths need not be just strings. In fact, there are
 * perfectly valid use-cases where you might need to access
 * a key, but the name of the key is stored in some
 * variable. In this case, you can specify an array of
 * strings -- or even an array of key paths -- and they
 * can be flattened into a regular key path.
 *
 * Using key paths, you are not limited to setting top-
 * level keys like you would be with LocalStorage. With
 * Electron Settings, you can deeply nest properties like
 * you would with any other object in JavaScript, and it
 * just feels natural.
 *
 * @typedef KeyPath
 * @type {(string|string[])}
 */

/**
 * A helper function which flattens a key path into a
 * string.
 *
 * Examples:
 *
 *   1. Passes a string through.
 *
 *       ```
 *       flattenKeyPath('foo.bar');
 *       // => "foo.bar"
 *       ```
 *
 *   2. Flattens a key path array into a string key path.
 *
 *       ```
 *       flattenKeyPath(['foo', 'bar']);
 *       // => "foo.bar"
 *       ```
 *
 *   3. Flattens a nested key path array into a string key
 *      path.
 *
 *       ```
 *       flattenKeyPath([['foo', 'bar'], 'baz']);
 *       // => "foo.bar.baz"
 *       ```
 *
 * @param {KeyPath}
 * @returns {string}
 */
const flattenKeyPath = (keyPath) => {
  if (Array.isArray(keyPath)) {
    return keyPath.map((item) => {
      return flattenKeyPath(item);
    }).join('.');
  } else {
    return keyPath;
  }
};

/**
 * A helper function which checks if the given parameter
 * is a true key path or not.
 *
 * Examples:
 *
 *   1. Validates strings.
 *
 *       ```
 *       isKeyPath('foo');
 *       // => true

 *       isKeyPath('foo.bar');
 *       // => true

 *       isKeyPath(42);
 *       // => false
 *       ```
 *
 *   2. Validates arrays of key paths.
 *
 *       ```
 *       isKeyPath(['foo']);
 *       // => true

 *       isKeyPath(['foo', 'bar']);
 *       // => true

 *       isKeyPath(['foo', 42]);
 *       // => false
 *       ```
 *
 * @param {any} keyPath
 * @returns {boolean}
 */
const isKeyPath = (keyPath) => {
  if (typeof keyPath === 'string') {
    return true;
  } else if (Array.isArray(keyPath)) {
    for (let i = 0, len = keyPath.length; i < len; i++) {
      if (!isKeyPath(keyPath[i])) {
        return false;
      } else {
        if (i === len - 1) {
          return true;
        }
      }
    }
  } else {
    return false;
  }
};

/**
 * A simple persistent user settings framework for
 * Electron. Originally adapted from Atom's own
 * configuration manager and the settings manager of choice
 * for Electron's own demo app, electron-settings allows
 * you to persist user settings and other data simply and
 * easily.
 *
 * Examples:
 *
 *   1. Creates a new Electron Settings instance.
 *
 *       ```
 *       const settings = new ElectronSettings();
 *       ```
 *
 *   2. Creates a new Electron Settings instance but saves
 *      the settings file in the current directory.
 *
 *       ```
 *       const settings = new ElectronSettings({
 *         dir: __dirname,
 *       });
 *       ```
 *
 *   3. Creates a new Electron Settings instance but
 *      prettifies the output.
 *
 *       ```
 *       const settings = new ElectronSettings({
 *         prettify: true,
 *       });
 *       ```
 *
 *   4. Creates a new Electron Settings instance and
 *      encrypts the settings using an encryption key.
 *      Electron Settings uses the `aes-256-cbc` encryption
 *      algorithm by default.
 *
 *       ```
 *       const settings = new ElectronSettings({
 *         encryptionKey: 'Passw0rd!',
 *       });
 *       ```
 */
class ElectronSettings {

  /**
   * @typedef {Object} ElectronSettings~options
   * @property {boolean} [atomicSave=true]
   * @property {string} [dir]
   * @property {Electron} [electron]
   * @property {string} [encryptionAlgorithm="aes-256-cbc"]
   * @property {string} [encryptionKey]
   * @property {string} [fileName="settings.json"]
   * @property {boolean} [prettify=false]
   * @property {number} [spaces=2]
   */

  /**
   * Creates a new Electron Settings instance.
   *
   * @param {ElectronSettings~options} opts
   * @constructor
   */
  constructor(opts) {

    /**
     * @type {Object}
     * @private
     */
    this._config = { ...defaults, ...opts };
  }

  /**
   * Returns the Electron instance. This may be defined by
   * the user during instantiation.
   *
   * @returns {Electron}
   * @private
   */
  _getElectron() {
    if (this._config.electron) {
      return this._config.electron;
    } else {
      return electron;
    }
  }

  /**
   * Returns the Electron app. Depending on which process
   * this code is running in -- main or renderer -- we
   * may need to import the app via Remote.
   *
   * @see https://electronjs.org/docs/api/app#app
   * @see https://electronjs.org/docs/api/remote
   * @returns {Electron.App}
   * @private
   */
  _getElectronApp() {
    const electron = this._getElectron();
    const app = electron.app || electron.remote.app;

    return app;
  }

  /**
   * Returns the path to the directory where Electron
   * Settings will save data to. By default, this is the
   * Electron app's unique user data path, but a custom
   * directory can be defined during instantiation.
   *
   * @see https://electronjs.org/docs/api/app#appgetpathname
   * @returns {string}
   * @private
   */
  _getSettingsDirPath() {
    if (this._config.dir) {
      return this._config.dir;
    } else {
      return this._getElectronApp().getPath('userData');
    }
  }

  /**
   * Returns the path to the file where Electron Settings
   * will save data to.
   *
   * @returns {string}
   * @private
   */
  _getSettingsFilePath() {
    const dir = this._getSettingsDirPath();
    const filePath = path.join(dir, this._config.fileName);

    return filePath;
  }

  /**
   * Encrypts the given data using the encryption algorithm
   * and key, then returns the encrypted buffer.
   *
   * @param {string} data
   * @returns {Buffer}
   * @private
   */
  _encryptData(data) {
    const buffer = Buffer.from(data);
    const algorithm = this._config.encryptionAlgorithm;
    const key = this._config.encryptionKey;
    const cipher = crypto.createCipher(algorithm, key);
    const enc = Buffer.concat([cipher.update(buffer), cipher.final()]);

    return enc;
  }

  /**
   * Decrypts the given buffer using the algorithm and key
   * used to encrypt it, then returns the decrypted data
   * as a UTF-8 string.
   *
   * @param {Buffer} buffer
   * @returns {string}
   * @private
   */
  _decryptData(buffer) {
    const algorithm = this._config.encryptionAlgorithm;
    const key = this._config.encryptionKey;
    const decipher = crypto.createDecipher(algorithm, key);
    const dec = Buffer.concat([decipher.update(buffer), decipher.final()]);

    return dec.toString('utf8');
  }

  /**
   * Prepares the settings data by stringifying the
   * settings object, encrypting the data (if applicable),
   * then returning a buffer if the data is encrypted, or
   * otherwise a UTF-8 string.
   *
   * @param {Object} obj
   * @returns {string|Buffer}
   * @private
   */
  _prepareSettingsData(obj) {
    const numSpaces = this._config.prettify ? this._config.numSpaces : 0;
    const data = JSON.stringify(obj, null, numSpaces);

    let encryptedData = data;

    if (this._config.encryptionKey) {
      encryptedData = this._encryptData(data);
    }

    return encryptedData;
  }

  /**
   * Reconstructs the settings object by decrypting the
   * settings object (if applicable), parsing it back into
   * JSON, then returning the resulting Object.
   *
   * @param {string|Buffer} data
   * @returns {Object}
   * @private
   */
  _reconstructSettingsData(data) {
    let decryptedData = data;

    if (this._config.encryptionKey) {
      decryptedData = this._decryptData(data);
    }

    return JSON.parse(decryptedData);
  }

  /**
   * Ensures the directory where the settings file will be
   * saved exists.
   *
   * @param {Function} fn
   * @returns {void}
   * @private
   */
  _ensureSettingsDir(fn) {
    const dir = this._getSettingsDirPath();

    fs.stat(dir, (err) => {
      if (err) {
        if (err.code === 'ENOENT') {
          // Directory does not exist.
          mkdirp(dir, fn);
        } else {
          fn(err);
        }
      } else {
        fn(null);
      }
    });
  }

  /**
   * Synchronously ensures the directory where the settings
   * file will be saved exists.
   *
   * @returns {void}
   * @private
   */
  _ensureSettingsDirSync() {
    const dir = this._getSettingsDirPath();

    try {
      fs.statSync(dir);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Directory does not exist.
        mkdirp.sync(dir);
      } else {
        throw err;
      }
    }
  }

  /**
   * Ensures that the sttings file exists. If no file
   * exists, then it is created and an empty object is
   * saved.
   *
   * @param {Function} fn
   * @returns {void}
   * @private
   */
  _ensureSettingsFile(fn) {
    const filePath = this._getSettingsFilePath();

    fs.stat(filePath, (err) => {
      if (err) {
        if (err.code === 'ENOENT') {
          this._saveSettings({}, fn);
        } else {
          fn(err);
        }
      } else {
        fn(null);
      }
    });
  }

  /**
   * Synchronously ensures that the sttings file exists. If
   * no file exists, then it is created and an empty object
   * is saved.
   *
   * @returns {void}
   * @private
   */
  _ensureSettingsFileSync() {
    const filePath = this._getSettingsFilePath();

    try {
      fs.statSync(filePath);
    } catch (err) {
      if (err) {
        if (err.code === 'ENOENT') {
          this._saveSettingsSync({});
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Ensures the settings file exists then writes the
   * settings to the file system.
   *
   * @param {string} data
   * @param {Function} fn
   * @returns {void}
   * @private
   */
  _writeSettingsFile(data, fn) {
    const filePath = this._getSettingsFilePath();

    this._ensureSettingsDir((err) => {
      if (err) return fn(err);

      if (this._config.atomicSave) {
        writeFileAtomic(filePath, data, fn);
      } else {
        fs.writeFile(filePath, data, fn);
      }
    });
  }

  /**
   * Synchronously Ensures the settings file exists then
   * writes the settings to the file system.
   *
   * @param {string} data
   * @returns {void}
   * @private
   */
  _writeSettingsFileSync(data) {
    const filePath = this._getSettingsFilePath();

    this._ensureSettingsDirSync();

    if (this._config.atomicSave) {
      writeFileAtomic.sync(filePath, data);
    } else {
      fs.writeFileSync(filePath, data);
    }
  }

  /**
   * @callback ElectronSettings~readSettingsFileCallback
   * @param {?Error} err
   * @param {?Object} obj
   */

  /**
   * Reads the (potentially encrypted) settings data from
   * the disk then reconstructs it back into a JSON object.
   *
   * @param {ElectronSettings~readSettingsFileCallback} fn
   * @returns {void}
   * @private
   */
  _readSettingsFile(fn) {
    const filePath = this._getSettingsFilePath();
    const encoding = this._config.encryptionKey ? null : 'utf-8';

    fs.readFile(filePath, encoding, (err, data) => {
      if (err) return fn(err);

      try {
        fn(null, this._reconstructSettingsData(data));
      } catch (err) {
        fn(err);
      }
    });
  }

  /**
   * Synchronously reads the (potentially encrypted)
   * settings data from the disk then reconstructs it back
   * into a JSON object.
   *
   * @returns {Object}
   * @private
   */
  _readSettingsFileSync() {
    const filePath = this._getSettingsFilePath();
    const encoding = this._config.encryptionKey ? null : 'utf-8';
    const data = fs.readFileSync(filePath, encoding);
    const obj = this._reconstructSettingsData(data);

    return obj;
  }

  /**
   * Saves the settings object to the disk.
   *
   * @param {Object} obj
   * @param {Function} fn
   * @returns {void}
   * @private
   */
  _saveSettings(obj, fn) {
    let data;

    try {
      data = this._prepareSettingsData(obj);
    } catch (err) {
      return fn(err);
    }

    this._writeSettingsFile(data, fn);
  }

  /**
   * Synchronously saves the settings object to the disk.
   *
   * @param {Object} obj
   * @returns {void}
   * @private
   */
  _saveSettingsSync(obj) {
    const data = this._prepareSettingsData(obj);

    this._writeSettingsFileSync(data);
  }

  /**
   * @callback ElectronSettings~loadSettingsCallback
   * @param {?Error} err
   * @param {?Object} obj
   */

  /**
   * Loads the settings data from the disk.
   *
   * @param {ElectronSettings~loadSettingsCallback}
   * @returns {void}
   * @private
   */
  _loadSettings(fn) {
    this._ensureSettingsFile((err) => {
      if (err) return fn(err);

      this._readSettingsFile(fn);
    });
  }

  /**
   * Synchronously loads the settings data from the disk.
   *
   * @returns {Object}
   * @private
   */
  _loadSettingsSync() {
    this._ensureSettingsFileSync();

    const obj = this._readSettingsFileSync();

    return obj;
  }

  /**
   * Gets the setting value at the given key path, or gets
   * the entire settings object if the key path is null.
   *
   * @param {?string} keyPath
   * @param {Function} fn
   * @returns {void}
   * @private
   */
  _getValueAtKeyPath(keyPath, fn) {
    this._loadSettings((err, obj) => {
      if (err) return fn(err);

      if (keyPath) {
        const val = keyPathHelpers.getValueAtKeyPath(obj, keyPath);

        fn(null, val);
      } else {
        fn(null, obj);
      }
    });
  }

  /**
   * Synchronously gets the setting value at the given key
   * path, or gets the entire settings object if the key
   * path is null.
   *
   * @param {?string} keyPath
   * @returns {any}
   * @private
   */
  _getValueAtKeyPathSync(keyPath) {
    const obj = this._loadSettingsSync();

    if (keyPath) {
      const val = keyPathHelpers.getValueAtKeyPath(obj, keyPath);

      return val;
    } else {
      return obj;
    }
  }

  /**
   * Checks if the key path exists.
   *
   * @param {string} keyPath
   * @param {ElectronSettings~hasCallback} fn
   * @returns {void}
   * @private
   */
  _hasKeyPath(keyPath, fn) {
    this._loadSettings((err, obj) => {
      if (err) return fn(err);

      const exists = keyPathHelpers.hasKeyPath(obj, keyPath);

      fn(null, exists);
    });
  }

  /**
   * Synchronously if the key path exists.
   *
   * @param {string} keyPath
   * @returns {boolean}
   * @private
   */
  _hasKeyPathSync(keyPath) {
    const obj = this._loadSettingsSync();
    const exists = keyPathHelpers.hasKeyPath(obj, keyPath);

    return exists;
  }

  /**
   * Sets the value at the given key path, or sets the
   * entire settings object if the key path is null.
   *
   * @param {?string} keyPath
   * @param {any} val
   * @param {ElectronSettings~setCallback} fn
   * @returns {void}
   * @private
   */
  _setValueAtKeyPath(keyPath, val, fn) {
    if (keyPath) {
      this._loadSettings((err, obj) => {
        if (err) return fn(err);

        keyPathHelpers.setValueAtKeyPath(obj, keyPath, val);

        this._saveSettings(obj, fn);
      });
    } else {
      this._saveSettings(val, fn);
    }
  }

  /**
   * Synchronously sets the value at the given key path, or
   * sets the entire settings object if the key path is
   * null.
   *
   * @param {?string} keyPath
   * @param {any} val
   * @returns {void}
   * @private
   */
  _setValueAtKeyPathSync(keyPath, val) {
    if (keyPath) {
      const obj = this._loadSettingsSync();

      keyPathHelpers.setValueAtKeyPath(obj, keyPath, val);

      this._saveSettingsSync(obj);
    } else {
      this._saveSettingsSync(val);
    }
  }

  /**
   * Deletes the setting at the given key path.
   *
   * @param {string} keyPath
   * @param {ElectronSettings~deleteCallback} fn
   * @returns {void}
   * @private
   */
  _deleteValueAtKeyPath(keyPath, fn) {
    this._loadSettings((err, obj) => {
      if (err) return fn(err);

      keyPathHelpers.deleteValueAtKeyPath(obj, keyPath);

      this._saveSettings(obj, fn);
    });
  }

  /**
   * Synchronously deletes the setting at the given key
   * path.
   *
   * @param {string} keyPath
   * @returns {void}
   * @private
   */
  _deleteValueAtKeyPathSync(keyPath) {
    const obj = this._loadSettingsSync();

    keyPathHelpers.deleteValueAtKeyPath(obj, keyPath);

    this._saveSettingsSync(obj);
  }

  /**
   * Returns the absolute path to the settings file.
   *
   * Examples:
   *
   *   1. Gets the path to the settings file.
   *
   *       ```
   *       settings.file();
   *       ```
   *
   * @returns {string}
   * @public
   */
  file() {
    return this._getSettingsFilePath();
  }

  /**
   * @callback ElectronSettings~getCallback
   * @param {?Error} err
   * @param {any} val
   */

  /**
   * Asynchronously gets the value at the given key path,
   * or returns the entire settings object if no key path
   * is given.
   *
   * Examples:
   *
   *   1. Gets the value at the key.
   *
   *       ```
   *       settings.get('foo', (err, val) => {
   *         console.log(val);
   *       });
   *       ```
   *
   *   2. Gets the value at the key path.
   *
   *       ```
   *       settings.get('foo.bar', (err, val) => {
   *         console.log(val);
   *       });
   *       ```
   *
   *   3. Gets the value at the escaped key path. This is
   *      is useful if your settings key contains a period.
   *      Ordinarily, periods are interpreted as key path
   *      delimeters, but by adding an escape sequence you
   *      can ask Electron Settings to treat the period as
   *      part of the key itself.
   *
   *       ```
   *       settings.get('foo\\.bar', (err, val) => {
   *         console.log(val);
   *       });
   *       ```
   *
   *   4. Gets the value at the array key path. This is
   *      useful if part of your key path is constructed
   *      using some sort of variable.
   *
   *       ```
   *       const bar = 'bar';
   *       settings.get(['foo', bar], (err, val) => {
   *         console.log(val);
   *       });
   *       ```
   *
   *   5. Gets all settings. If you omit the key path
   *      argument, Electron Settings will return the
   *      entire settings object instead of just the value
   *      at a single key path.
   *
   *       ```
   *       settings.get((err, obj) => {
   *         console.log(obj);
   *       });
   *       ```
   *
   * @param {KeyPath} keyPath
   * @param {ElectronSettings~getCallback} fn
   * @returns {void}
   * @public
   */
  get(...args) {
    if (isKeyPath(args[0])) {
      args.splice(0, 1, flattenKeyPath(args[0]));
    } else {
      args.splice(0, 0, null);
    }

    this._getValueAtKeyPath(...args);
  }

  /**
   * Synchronously gets the value at the given key path, or
   * returns the entire settings object if no key path is
   * provided.
   *
   * Examples:
   *
   *   1. Gets the value at the key.
   *
   *       ```
   *       const val = settings.getSync('foo');
   *       ```
   *
   *   2. Gets the value at the key path.
   *
   *       ```
   *       const val = settings.getSync('foo.bar');
   *       ```
   *
   *   3. Gets the value at the escaped key path. This is
   *      is useful if your settings key contains a period.
   *      Ordinarily, periods are interpreted as key path
   *      delimeters, but by adding an escape sequence you
   *      can ask Electron Settings to treat the period as
   *      part of the key itself.
   *
   *       ```
   *       const val = settings.getSync('foo\\.bar');
   *       ```
   *
   *   4. Gets the value at the array key path. This is
   *      useful if part of your key path is constructed
   *      using some sort of variable.
   *
   *       ```
   *       const bar = 'bar';
   *       const val = settings.getSync(['foo', bar]);
   *       ```
   *
   *   5. Gets all settings. If you omit the key path
   *      argument, Electron Settings will return the
   *      entire settings object instead of just the value
   *      at a single key path.
   *
   *       ```
   *       const obj = settings.getSync();
   *       ```
   *
   * @param {KeyPath} keyPath
   * @returns {any}
   * @public
   */
  getSync(...args) {
    if (isKeyPath(args[0])) {
      args.splice(0, 1, flattenKeyPath(args[0]));
    } else {
      args.splice(0, 0, null);
    }

    return this._getValueAtKeyPathSync(...args);
  }

  /**
   * @callback ElectronSettings~hasCallback
   * @param {?Error} err
   * @param {?boolean} exists
   */

  /**
   * Asynchronously checks if the the given key path exists.
   *
   * Examples:
   *
   *   1. Checks if the key exists.
   *
   *       ```
   *       settings.has('foo', (err, exists) => {
   *         console.log(exists);
   *       });
   *       ```
   *
   *   2. Checks if the key path exists.
   *
   *       ```
   *       settings.has('foo.bar', (err, exists) => {
   *         console.log(exists);
   *       });
   *       ```
   *
   *   3. Checks if the the escaped key path exists. This
   *      is is useful if your settings key contains a
   *      period. Ordinarily, periods are interpreted as
   *      key path delimeters, but by adding an escape
   *      sequence you can ask Electron Settings to treat
   *      the period as part of the key itself.
   *
   *       ```
   *       settings.has('foo\\.bar', (err, exists) => {
   *         console.log(exists);
   *       });
   *       ```
   *
   *   4. Checks if the array key path exists. This is
   *      useful if part of your key path is constructed
   *      using some sort of variable.
   *
   *       ```
   *       const bar = 'bar';
   *       settings.has(['foo', bar], (err, exists) => {
   *         console.log(exists);
   *       });
   *       ```
   *
   * @param {KeyPath} keyPath
   * @param {ElectronSettings~hasCallback} fn
   * @returns {void}
   * @public
   */
  has(...args) {
    if (isKeyPath(args[0])) {
      args.splice(0, 1, flattenKeyPath(args[0]));
    } else {
      throw new TypeError('A valid key path must be provided');
    }

    this._hasKeyPath(...args);
  }

  /**
   * Synchronously checks if the the given key path exists.
   *
   * Examples:
   *
   *   1. Checks if the key exists.
   *
   *       ```
   *       const exists = settings.hasSync('foo');
   *       ```
   *
   *   2. Checks if the key path exists.
   *
   *       ```
   *       const exists = settings.hasSync('foo.bar');
   *       ```
   *
   *   3. Checks if the the escaped key path exists. This
   *      is is useful if your settings key contains a
   *      period. Ordinarily, periods are interpreted as
   *      key path delimeters, but by adding an escape
   *      sequence you can ask Electron Settings to treat
   *      the period as part of the key itself.
   *
   *       ```
   *       const exists = settings.hasSync('foo\\.bar');
   *       ```
   *
   *   4. Checks if the array key path exists. This is
   *      useful if part of your key path is constructed
   *      using some sort of variable.
   *
   *       ```
   *       const bar = 'bar';
   *       const exists = settings.hasSync(['foo', bar]);
   *       ```
   *
   * @param {KeyPath} keyPath
   * @returns {boolean}
   * @public
   */
  hasSync(...args) {
    if (isKeyPath(args[0])) {
      args.splice(0, 1, flattenKeyPath(args[0]));
    } else {
      throw new TypeError('A valid key path must be provided');
    }

    return this._hasKeyPathSync(...args);
  }

  /**
   * @callback ElectronSettings~setCallback
   * @param {?Error} err
   */

  /**
   * Asynchronously sets the value at the given key path,
   * or set the entire settings object if no key path is
   * given.
   *
   * Examples:
   *
   *   1. Sets the value at the key.
   *
   *       ```
   *       settings.set('foo', 'bar', (err) => {
   *         // ...
   *       });
   *       ```
   *
   *   2. Sets the value at the key path.
   *
   *       ```
   *       settings.set('foo.bar', 'baz', (err) => {
   *         // ...
   *       });
   *       ```
   *
   *   3. Sets the value at the escaped key path. This is
   *      is useful if your settings key contains a period.
   *      Ordinarily, periods are interpreted as key path
   *      delimeters, but by adding an escape sequence you
   *      can ask Electron Settings to treat the period as
   *      part of the key itself.
   *
   *       ```
   *       settings.set('foo\\.bar', 'baz', (err) => {
   *         // ...
   *       });
   *       ```
   *
   *   4. Sets the value at the array key path. This is
   *      useful if part of your key path is constructed
   *      using some sort of variable.
   *
   *       ```
   *       const bar = 'bar';
   *       settings.set(['foo', bar], 'baz', (err) => {
   *         // ...
   *       });
   *       ```
   *
   *   5. Sets all settings. If you omit the key path
   *      argument, Electron Settings will return the
   *      entire settings object instead of just the value
   *      at a single key path.
   *
   *       ```
   *       settings.set({ foo: 'bar' }, (err) => {
   *         // ...
   *       });
   *       ```
   *
   * @param {KeyPath} [keyPath]
   * @param {any} val
   * @param {ElectronSettings~setCallback} fn
   * @returns {void}
   * @public
   */
  set(...args) {
    if (isKeyPath(args[0])) {
      args.splice(0, 1, flattenKeyPath(args[0]));
    } else {
      args.splice(0, 0, null);
    }

    this._setValueAtKeyPath(...args);
  }

  /**
   * Synchronously sets the value at the given key path,
   * or set the entire settings object if no key path is
   * given.
   *
   * Examples:
   *
   *   1. Sets the value at the key.
   *
   *       ```
   *       settings.setSync('foo', (e);
   *       ```
   *
   *   2. Sets the value at the key path.
   *
   *       ```
   *       settings.setSync('foo.bar', 'baz');
   *       ```
   *
   *   3. Sets the value at the escaped key path. This is
   *      is useful if your settings key contains a period.
   *      Ordinarily, periods are interpreted as key path
   *      delimeters, but by adding an escape sequence you
   *      can ask Electron Settings to treat the period as
   *      part of the key itself.
   *
   *       ```
   *       settings.setSync('foo\\.bar', 'baz');
   *       ```
   *
   *   4. Sets the value at the array key path. This is
   *      useful if part of your key path is constructed
   *      using some sort of variable.
   *
   *       ```
   *       const bar = 'bar';
   *       settings.setSync(['foo', bar], 'baz');
   *       ```
   *
   *   5. Sets all settings. If you omit the key path
   *      argument, Electron Settings will return the
   *      entire settings object instead of just the value
   *      at a single key path.
   *
   *       ```
   *       settings.setSync({ foo: 'bar' });
   *       ```
   *
   * @param {KeyPath} [keyPath]
   * @param {any} val
   * @returns {void}
   * @public
   */
  setSync(...args) {
    if (isKeyPath(args[0])) {
      args.splice(0, 1, flattenKeyPath(args[0]));
    } else {
      args.splice(0, 0, null);
    }

    this._setValueAtKeyPathSync(...args);
  }

  /**
   * @callback ElectronSettings~deleteCallback
   * @param {?Error} err
   */

  /**
   * Asynchronously deletes the given key path.
   *
   * Examples:
   *
   *   1. Deletes the key.
   *
   *       ```
   *       settings.delete('foo', (err) => {
   *         // ...
   *       });
   *       ```
   *
   *   2. Deletes the final key of the key path.
   *
   *       ```
   *       settings.delete('foo.bar', (err) => {
   *         // ...
   *       });
   *       ```
   *
   *   3. Deletes the final key of the escaped key path.
   *      This is is useful if your settings key contains a
   *      period. Ordinarily, periods are interpreted as
   *      key path delimeters, but by adding an escape
   *      sequence you can ask Electron Settings to treat
   *      the period as part of the key itself.
   *
   *       ```
   *       settings.delete('foo\\.bar', (err) => {
   *         // ...
   *       });
   *       ```
   *
   *   4. Deletes the final key of the array key path. This
   *      is useful if part of your key path is constructed
   *      using some sort of variable.
   *
   *       ```
   *       const bar = 'bar';
   *       settings.delete(['foo', bar], (err) => {
   *         // ...
   *       });
   *       ```
   *
   * @param {KeyPath} keyPath
   * @param {ElectronSettings~deleteCallback} fn
   * @returns {void}
   * @public
   */
  delete(...args) {
    if (isKeyPath(args[0])) {
      args.splice(0, 1, flattenKeyPath(args[0]));
    } else {
      throw new TypeError('A valid key path must be provided');
    }

    this._deleteValueAtKeyPath(...args);
  }

  /**
   * Synchronously deletes the given key path.
   *
   * Examples:
   *
   *   1. Deletes the key.
   *
   *       ```
   *       settings.deleteSync('foo');
   *       ```
   *
   *   2. Deletes the final key of the key path.
   *
   *       ```
   *       settings.deleteSync('foo.bar');
   *       ```
   *
   *   3. Deletes the final key of the escaped key path.
   *      This is is useful if your settings key contains a
   *      period. Ordinarily, periods are interpreted as
   *      key path delimeters, but by adding an escape
   *      sequence you can ask Electron Settings to treat
   *      the period as part of the key itself.
   *
   *       ```
   *       settings.deleteSync('foo\\.bar');
   *       ```
   *
   *   4. Deletes the final key of the array key path. This
   *      is useful if part of your key path is constructed
   *      using some sort of variable.
   *
   *       ```
   *       const bar = 'bar';
   *       settings.deleteSync(['foo', bar]);
   *       ```
   *
   * @param {KeyPath} keyPath
   * @returns {void}
   * @public
   */
  deleteSync(...args) {
    if (isKeyPath(args[0])) {
      args.splice(0, 1, flattenKeyPath(args[0]));
    } else {
      throw new TypeError('A valid key path must be provided');
    }

    this._deleteValueAtKeyPathSync(...args);
  }
}

module.exports = ElectronSettings;
