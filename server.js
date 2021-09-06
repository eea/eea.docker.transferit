/*
 * EEA transfer
 * Author: Mauro Michielon
*/
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const redis = require('redis');
const redisStore = require('connect-redis')(session);
const ldapjs = require('ldapjs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const nextcloud = require('nextcloud-node-client').Client;
const nodemailer = require('nodemailer');
//const date = require('date-and-time');
require('dotenv').config();
const alert = require('alert');
const dateFormat = require('dateformat');
const request = require('request');
const util = require('util');
var log4js = require("log4js");
var logger = log4js.getLogger();
logger.level = "debug";
const { forEach } = require('p-iteration');

let appType = process.env.APPTYPE || 'transfer';

let redisHost = process.env.REDISHOST || 'localhost';
let redisPort = process.env.REDISPORT || 6379;
let redisSecret = process.env.REDISSECRET || 'changeme';
let redisTtl = process.env.REDISTTL || 14400;

let appHeading = process.env.APPHEADING || 'changeme';
let appSubHeading = process.env.APPSUBHEADING || 'changeme';
let appTitle = process.env.APPTITLE || 'changeme';

let postfixHost = process.env.POSTFIXHOST || 'changeme';
let senderEmail = process.env.SENDEREMAIL || 'changeme@changeme.org';

let ldaphost = process.env.LDAPHOST || 'changeme';
let ldapdn = process.env.LDAPDN || 'changeme';

const redisClient = redis.createClient({ host: redisHost, port: redisPort });
redisClient.on('error', err => {
    logger.error('Error ' + err);
    return;
});
redisClient.on('connect',()=>{
    logger.info('Successfully connected to redis service');
})

const app = express();

//app.use((req, res, next) => {
//  res.header("Vary", "X-Requested-With");
//  next();
//});

app.use(session({
    secret: redisSecret,
    store: new redisStore({ host: redisHost, port: redisPort, client: redisClient, ttl : redisTtl }),
    saveUninitialized: false,
    resave: false
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(express.static('./public'));
//app.disable('view cache');

app.get('/', async (req, res) => {
  //check if nextcloud is working as expected
  const requestPromise = util.promisify(request);
  try {
    const response = await requestPromise(process.env.NEXTCLOUD_URL + '/status.php');
  } catch(error) {
    logger.error(error);
    res.render('failure', {appHeading : appHeading, appSubHeading : appSubHeading, error: "Something is quite not right with nextcloud"});
    return;
  }
 
  //is req.session.username is defined, user is logged in
  if (req.session.username) {
    username = req.session.username;
    if (!req.session.folderName) {
      var createSharedFolderResponse = await createSharedFolder ();
      req.session.folderName = process.env.NEXTCLOUD_URL + '/s/' + createSharedFolderResponse[0];
      req.session.shareId = createSharedFolderResponse[1];
    }   
    
    //if req.session.sent === 1, it means that back button has been presssed after having successfully sent the email
    if (req.session.sent === 1) {
      res.render('sent', {appHeading : appHeading, appSubHeading : appSubHeading, error: ''});
    } else {
      res.render('index', { appHeading : appHeading, appSubHeading : appSubHeading, username: username, folderName: req.session.folderName});  
    }
  } else {
    //force login as req.session.username is not set
    if (req.session.error) {
      error = req.session.error.lde_message;
    } else {
      error = null;
    }
    res.render('login', {appHeading : appHeading, appSubHeading : appSubHeading, error: error})
    req.session.error = null;
  }
});

app.post('/', async (req, res) => {
  req.session.sent = 0;
  //if username is not set,  try to authenticate and redirect to GET /
  if (!req.session.username) {
    await autenticationDN ( req.body.username, req.body.password, function(result) {
      if (result === 200) {
        req.session.username = req.body.username;
	//no need to store the password
	req.body.password = '';
      } else {
        req.session.error = result;
      }
      res.redirect('/');
    });
  } else {

    //is start over is clicked, reload and force the regeneraion of the share
    if (req.body.submitButton === 'startOver') {
      req.session.folderName = ''; 
      res.redirect('/');
    }

    if (req.body.submitButton === 'send') {
      //logger.info ('retention: ' + req.body.retention);
      const currentDate = new Date();
      currentDate.setDate(currentDate.getDate() + parseInt(req.body.retention));
      var composedMessage = await composeMessage(req.session.username, req.body.message, req.session.folderName, dateFormat(currentDate, "dd/mm/yyyy"), req.body.password); 
      logger.info ('about to send with user: ' + req.session.username + ' retention: ' + req.body.retention)
      #console.log("composedMessage: " + composedMessage);
      try {
        updateSharedFolder(req.session.folderName, req.session.shareId, req.body.retention, req.body.password);
        //dateFormat(currentDate, "dd/mm/yyyy")

        var emails = req.body.email.split(",");
        emails = removeArrayDubplicates(emails);

        const sendAllEmails = async () => {
          for (let emailIndex = 0; emailIndex <= emails.length-1; emailIndex++) {
            if ( appType === 'transfer' ) {
              await sendEmail(senderEmail, emails[emailIndex], '[EEA TRANSFER] user "' + req.session.username + '" wants to send you some files via a shared folder', composedMessage);
            } else {
              await sendEmail(senderEmail, emails[emailIndex], '[EEA TRANSLATION SERVICES] " new translation files to be audited via a shared folder', composedMessage);
            }
          }
        };

        await sendAllEmails()
        //to avoid people to use the back button of the browser and reuse the same req.session.folderName
        req.session.sent = 1;
        res.render('sent', {appHeading : appHeading, appSubHeading : appSubHeading, error: ''});
      } catch(error) {
        logger.error('sendEmail: ' + error);
        res.render('failure', {appHeading : appHeading, appSubHeading : appSubHeading, error: error});
        return;
      }
    }
    
  }
});

function removeArrayDubplicates(array) {
  return array.filter(function (item, index) {
    return array.indexOf(item) === index;
  });
};

async function wait(ms) {
    setTimeout(ms);
    return 1;
}

app.get('/logout', (req,res) => {
  req.session.destroy((err) => {
    if(err) {
      return logger.error('/logout:' + err);
    }
    res.redirect('/');
  });
});

async function composeMessage (username, originalMessage, folderName, expiryDate, password) {
//  if (originalMessage != "") { originalMessage = '\n\ralong with the following message : \n\r"' + originalMessage + '"'};

  message = 'Eionet user "' + username + '" wants to send you some files via a shared folder: \n\r' + folderName;
  if (password && password != '') { message = message + '  (the share is password protected; use: "' + password + '" to access it)'};
	 
  if (originalMessage && originalMessage != '') {message = message + '\n\rWith the following message : \n\r"' + originalMessage + '"'};

  message = message + '\n\rThe folder will be accessible until ' + expiryDate;

  return message;
}

async function sendEmail (from, to, subject, text) {
  var transporter = nodemailer.createTransport({
    host: postfixHost,
    port: 25,
    secure: false, // upgrade later with STARTTLS
    rejectUnauthorized: false,
    tls: {rejectUnauthorized: false}
  });

  var mailOptions = {
    from: from,
    to: to,
    subject: subject,
    text: text
  };

  var info = await transporter.sendMail(mailOptions);
  logger.info("Message sent: " + info.messageId)
  return info.messageId;
}

async function autenticationDN ( username, password, callback ) {
   let ldapClient = ldapjs.createClient ({ url: 'ldaps://' + ldaphost });
   ldapClient.bind('uid=' + username + ',' + ldapdn, password, function (err) {
     if (err) {
	 //logger.error('LDAP bind error code: ' + err.code + ' - ' + err);
	 callback (err) 
     } else {
         callback (200)
     };
   });
}

//create folder in nextcloud, share it, rename the folder upon the share name
//server credentials are taken via env variables:
//NEXTCLOUD_USERNAME, NEXTCLOUD_PASSWORD, NEXTCLOUD_URL
async function createSharedFolder () {
  var folder = uuidv4();
  var shareName;
  var shareHandler;
  try {
    const ncClient = new nextcloud();
    const folderHandler = await ncClient.createFolder( folder );
    shareHandler = await ncClient.createShare({ fileSystemElement: folderHandler });
    
    await ncClient.updateShare(shareHandler.memento.id, { permissions: 15 });
    shareName = shareHandler.memento.url.substring(shareHandler.memento.url.lastIndexOf('/') + 1);
    const fileHandler = await ncClient.getFolder("/" + folder);
    //updating the folder name upone the share name
    await fileHandler.move("/" + shareName);
    await fileHandler.addTag("retention10days");
  } catch (e) {
    logger.error('createSharedFolder: ' + e);
    alert('Connection with nc server failed: ' + e);
    return (e);
  }
  return [shareName, shareHandler.memento.id];
}

//once the email is sent, the shared folder is set as readonly 
//and the retention tag is assigned upon the user's choice
async function updateSharedFolder ( folder, shareId, retention, password ) {
  
  try {
    const ncClient = new nextcloud();
    const shareHandler = await ncClient.getShare(shareId);
    if (appType === 'transfer') {
      ncClient.updateShare(shareHandler.ocs.data[0].id, { permissions: 17 });
    } else {
      ncClient.updateShare(shareHandler.ocs.data[0].id, { hide_download: 1 });
    }

    if (password && password != '') {
      ncClient.updateShare(shareHandler.ocs.data[0].id, { password: password });
    }

    //ncClient.updateShare(shareHandler.ocs.data[0].id, { expireDate: retention.toISOString().split("T")[0] });
    //ncClient.updateShare(shareHandler.ocs.data[0].id, { expireDate: retention });
    //const fileHandler = await ncClient.getFolder("/" + folder);
    folder = folder.substring(folder.lastIndexOf("/")+1);//'Qipnr7rDqxgroKG';
    const folderHandler = await ncClient.getFolder("/" + folder);
    await folderHandler.removeTag("retention10days"); 
    folderHandler.addTag('retention' + retention + 'days');
  } catch (e) {
    logger.error('updateSharedFolder: ' + e);
    return (e);
  }
}

app.listen(process.env.PORT || 7000,() => {
    logger.info(`App Started on PORT ${process.env.PORT || 7000}`);
});
