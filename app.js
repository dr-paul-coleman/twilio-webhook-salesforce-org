const restify = require('restify');
const bunyan = require('bunyan');
const jsforce = require("jsforce");

const username = process.env.ORG_USER;
const password = process.env.ORG_PASSWORD_TOKEN;
const org = new jsforce.Connection({
    loginUrl: process.env.ORG_URL
});


const server = restify.createServer({
    name: 'Salesforce.org SMS Gateway',
    version: '1.0.0',
    "ignoreTrailingSlash": true
});
server.use(restify.plugins.dateParser());
server.use(restify.plugins.acceptParser(server.acceptable));
server.use(restify.plugins.authorizationParser());
server.use(restify.plugins.queryParser({mapParams: true}));
server.use(restify.plugins.jsonp());
server.use(restify.plugins.fullResponse());
server.use(restify.plugins.bodyParser({maxBodySize: 2097152, mapParams: false})); //2MB limit
server.use(restify.plugins.throttle({
    burst: 100,
    rate: 50,
    ip: true,
    overrides: {
        '192.168.1.1': {
            rate: 0,        // unlimited
            burst: 0
        }
    }
}));
server.use(restify.plugins.gzipResponse());

server.on('after', restify.plugins.auditLogger({
    log: bunyan.createLogger({
        name: 'audit',
        stream: process.stdout
    }),
    event: 'after',
    printLog: true
}));

function validateRequest(req, resp, next) {

    //require https when running in heroku host, otherwise allow localhost access only
    const isHeroku = req.headers["x-forwarded-proto"] === "https" && process.env.DYNO;
    if (isHeroku || !process.env.DYNO) { // force https on remote heroku dynos
        var origin = req.header("Origin");
        resp.header("Access-Control-Allow-Origin", origin);
        resp.header("Access-Control-Allow-Methods", "POST");
        resp.header("Access-Control-Allow-Headers", req.header("Access-Control-Request-Headers"));
        return next();
    } else {
        resp.send(500, {"500": "Unsupported Protocol HTTP"});
        return next(false);
    }
}

function routeToSalesforce(req, resp, next) {

    org.login(username, password, function (err, userInfo) {
        return err ? console.error(err) : console.log(userInfo);
    }).then(r => {
        const fromPhone = (req.params.From || req.params.from).replace(' ', '+');
        const responseText = req.params.Body || req.params.body;

        const salesforceUrl = `${org.instanceUrl}/services/apexrest/sms/v1?From=${fromPhone}&Body=${responseText}`;
        const headers = {Authorization: `Bearer ${org.accessToken}`, Accept: '*'};

        console.log('Sending Request to Salesforce: ' + salesforceUrl);
        org.requestGet(salesforceUrl, {headers: headers}).then(sf_response => {
            console.log('Salesforce response: ' + sf_response);
            resp.header('Content-Type', 'text/plain; charset=utf-8');
            resp.send(200, sf_response);
            return next(false);
        }).catch(e => {
            console.error(e);
            resp.send(500, ""); // don't send response to to twilio lest it be returned to sms user's phone
            return next(false);
        });
    }).catch(e => {
        console.error(e);
        resp.send(500, ""); // don't send response to to twilio lest it be returned to sms user's phone
        return next(false);
    });
}

server.get("/webhook", validateRequest, routeToSalesforce);
server.post("/webhook", validateRequest, routeToSalesforce);

server.get("*", function (req, res, next) {
    return next(new Error("Invalid Request"));
});

server.listen(process.env.PORT || 5000, function () {
    console.log('%s listening at %s', server.name, server.url);
});
