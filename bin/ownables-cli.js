#!/usr/bin/env node

const { program } = require("commander");
const chalk = require("chalk");
const { create } = require("../lib/commands/create");
const { build } = require("../lib/commands/build");

program
  .name("ownables-cli")
  .description("CLI tool for creating and building Ownables")
  .version("1.0.0");

program
  .command("create")
  .description("Create a new Ownable template in the current directory")
  .action(async () => {
    try {
      await create();
    } catch (error) {
      console.error(chalk.red("Error:"), error.message);
      process.exit(1);
    }
  });

program
  .command("build")
  .description("Build an Ownable from the current directory")
  .action(async () => {
    try {
      await build();
    } catch (error) {
      console.error(chalk.red("Error:"), error.message);
      process.exit(1);
    }
  });

program.parse();
