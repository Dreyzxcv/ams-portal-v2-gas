/** Code.gs - web app entry point. */
function doGet(e) {
  var t = HtmlService.createTemplateFromFile('Index');
  return t.evaluate()
    .setTitle(APP_NAME + ' Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}
/** Server-side include used by Index.html: <?!= include('Styles') ?> */
function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

/** Time-driven jobs (installed by installTriggers). */
function jobSubmitExpiredQuizAttempts() { return Quizzes.submitExpired(); }
function jobCleanup() { Sessions.purgeExpired(); Otp.purgeExpired(); }
