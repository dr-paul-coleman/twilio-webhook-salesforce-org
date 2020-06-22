const restify = require('restify');
const bunyan = require('bunyan');
const jsforce = require("jsforce");

const server = restify.createServer({name: 'Salesforce.org SMS Gateway', version: '1.0.0', "ignoreTrailingSlash": true});
server.use(restify.plugins.dateParser());
server.use(restify.plugins.acceptParser(server.acceptable));
server.use(restify.plugins.authorizationParser());
server.use(restify.plugins.queryParser({ mapParams: true }));
server.use(restify.plugins.jsonp());
server.use(restify.plugins.fullResponse());
server.use(restify.plugins.bodyParser({ maxBodySize: 2097152, mapParams: false })); //2MB limit
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
    printLog : true
}));


function cliAddress(req) {
    return req.connection.remoteAddress || req.socket.remoteAddress || req.headers['x-forwarded-for'];
}

server.isLocal = function(req) {
    return server.address() === "::" || cliAddress(req);
}

function validateRequest(req, resp, next) {

    //require https when running in heroku host, otherwise allow localhost access only
    if( req.headers["x-forwarded-proto"] === "https" || server.isLocal(req) ) {
            var origin = req.header("Origin");
            resp.header("Access-Control-Allow-Origin", origin);
            resp.header("Access-Control-Allow-Methods", "POST");
            resp.header("Access-Control-Allow-Headers", req.header("Access-Control-Request-Headers"));
            return next();
    } else {
        resp.send(500, {"500":"Unsupported Protocol HTTP"});
        return next(false);
    }
}

function doSalesforceIO(req, resp, next) {

    const username = process.env.ORG_USER;
    const password = process.env.ORG_PASSWORD_TOKEN;
    const urlenv = process.env.ORG_URL;

    const org = new jsforce.Connection({
        loginUrl : urlenv
    });

    org.login(username, password, function (err, userInfo) {
        return err ? console.error(err) : console.log(userInfo);
    }).then(r => {
        const fromPhone = (req.params.From || req.params.from).replace(' ', '+');
        const responseText = req.params.Body || req.params.body;

        const salesforceUrl = `${org.instanceUrl}/services/apexrest/sms/v1?From=${fromPhone}&Body=${responseText}`;
        const headers = {Authorization: `Bearer ${org.accessToken}`, Accept:'*'};

        org.requestGet(salesforceUrl, {headers: headers}).then(response => {
            console.log(response);
            resp.header('Content-Type', 'application/xml');
            resp.send(200, response);
            return next(false);
        }).catch(e => console.error(e) ) ;
    } );
}

server.get("/webhook", validateRequest, doSalesforceIO );
server.post("/webhook", validateRequest, doSalesforceIO);
server.get("*", function (req,res,next) {
  return next(new Error("Invalid Request"));
});


server.listen(process.env.PORT || 5000, function () {
  console.log('%s listening at %s', server.name, server.url);
});
