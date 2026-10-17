export { EmailChannel, DEFAULT_EMAIL_QUERY, type EmailChannelOptions } from './email.js';
export {
  GmailApiBackend,
  parseGmailMessage,
  buildMime,
  base64urlEncode,
  base64urlDecode,
  encodeHeaderValue,
  extractEmailAddress,
  MAX_BODY_CHARS,
  type GmailCredentials,
  type ParsedEmail,
  type SendEmailParams,
  type GmailApiBackendOptions,
} from './gmail.js';
