export default {
  port: "3306",
  connectionLimit: 100,
  retryCount: 3,
  connectionTimeout: 1000,

  canRetry: true,
  defaultSelector: "RR",
  restoreNodeTimeout: 10000,
  removeNodeErrorCount: 2
}
