// Synthetic connection only; no user credentials or public services.
process.env.ONIDOT_APP_URL='https://app.example.invalid';
process.env.ONIDOT_MCP_URL='https://mcp.example.invalid';
process.env.ONIDOT_ALIAS='fixture';
process.env.ONIDOT_SCOPE='onidot:wiki:read onidot:wiki:write offline_access';
export {config,getHeaders,writeState,stateDirectory} from '../source/runtime/oauth-helper.mjs';
