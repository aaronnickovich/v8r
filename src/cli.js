import flatCache from "flat-cache";
import fs from "fs";
import os from "os";
import path from "path";
import { validate } from "./ajv.js";
import { Cache } from "./cache.js";
import { getCatalogs, getMatchForFilename } from "./catalogs.js";
import { getConfig } from "./config.js";
import { getFiles } from "./glob.js";
import { getFromUrlOrFile } from "./io.js";
import logging from "./logging.js";
import { parseFile } from "./parser.js";

const EXIT = {
  VALID: 0,
  ERROR: 1,
  INVALID_CONFIG: 97,
  NOTFOUND: 98,
  INVALID: 99,
};

const CACHE_DIR = path.join(os.tmpdir(), "flat-cache");

function secondsToMilliseconds(seconds) {
  return seconds * 1000;
}

function getFlatCache() {
  if (process.env.V8R_CACHE_NAME) {
    return flatCache.load(process.env.V8R_CACHE_NAME);
  }
  return flatCache.load("v8r", CACHE_DIR);
}

async function validateFile(filename, config, cache) {
  logging.info(`Processing ${filename}`);
  try {
    const catalogs = getCatalogs(config);
    const catalogMatch = config.schema
      ? {}
      : await getMatchForFilename(catalogs, filename, cache);
    const schemaLocation = config.schema || catalogMatch.location;
    const schema = await getFromUrlOrFile(schemaLocation, cache);
    logging.info(
      `Validating ${filename} against schema from ${schemaLocation} ...`
    );

    const data = parseFile(
      await fs.promises.readFile(filename, "utf8"),
      catalogMatch.parser ? `.${catalogMatch.parser}` : path.extname(filename)
    );

    const valid = await validate(data, schema, cache);
    if (valid) {
      logging.success(`${filename} is valid\n`);
    } else {
      logging.error(`${filename} is invalid\n`);
    }

    if (valid) {
      return EXIT.VALID;
    }
    return EXIT.INVALID;
  } catch (e) {
    logging.error(`${e.message}\n`);
    return EXIT.ERROR;
  }
}

function mergeResults(results, ignoreErrors) {
  const codes = Object.values(results);
  if (codes.includes(EXIT.INVALID)) {
    return EXIT.INVALID;
  }
  if (codes.includes(EXIT.ERROR) && !ignoreErrors) {
    return EXIT.ERROR;
  }
  return EXIT.VALID;
}

function Validator() {
  return async function (config) {
    let filenames = [];
    for (const pattern of config.patterns) {
      const matches = await getFiles(pattern);
      if (matches.length === 0) {
        logging.error(`Pattern '${pattern}' did not match any files`);
        return EXIT.NOTFOUND;
      }
      filenames = filenames.concat(matches);
    }

    const ttl = secondsToMilliseconds(config.cacheTtl || 0);
    const cache = new Cache(getFlatCache(), ttl);

    const results = Object.fromEntries(filenames.map((key) => [key, null]));
    for (const [filename] of Object.entries(results)) {
      results[filename] = await validateFile(filename, config, cache);
      cache.resetCounters();
    }
    return mergeResults(results, config.ignoreErrors);
  };
}

async function cli(config) {
  if (!config) {
    try {
      config = await getConfig(process.argv);
    } catch (e) {
      logging.error(e.message);
      return EXIT.INVALID_CONFIG;
    }
  }

  logging.init(config.verbose);
  logging.debug(`Merged args/config: ${JSON.stringify(config, null, 2)}`);

  try {
    const validate = new Validator();
    return await validate(config);
  } catch (e) {
    logging.error(e.message);
    return EXIT.ERROR;
  } finally {
    logging.cleanup();
  }
}

export { cli };
