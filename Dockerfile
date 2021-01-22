FROM node:15-buster-slim

RUN mkdir -p /opt/app
WORKDIR /opt/app

ADD package.json /opt/app/
RUN npm update && \
    npm install 

ADD server.js /opt/app/
ADD public/ /opt/app/public
ADD views/ /opt/app/views

EXPOSE 7000

CMD node /opt/app/server.js

