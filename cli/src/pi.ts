#!/usr/bin/env node
import bareLaunch, { ARGV_USER_OFFSET } from "./bare.ts";

await bareLaunch(process.argv.slice(ARGV_USER_OFFSET));
