import { createDemoFundingRuntime } from "./demo-funding-runtime.js";
export function createProgramBackendDemoFunding({env=process.env,runtimeDir,createRuntime=createDemoFundingRuntime}={}){return createRuntime({env,runtimeDir})}
