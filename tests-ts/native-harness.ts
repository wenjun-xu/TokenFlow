import { main } from "../src/cli";

const args = process.argv.slice(2);
if (args[0] === "_test-start") process.exitCode = await main(["start", "--db", args[1], "--no-browser"], { state: args[2] });
else if (args[0] === "_test-stop") process.exitCode = await main(["stop"], { state: args[1] });
else if (args[0] === "_test-env") console.log(process.env.TOKENFLOW_AMBIENT_CONFIG_SENTINEL ?? "unloaded");
else process.exitCode = await main(args);
