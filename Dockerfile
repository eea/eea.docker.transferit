FROM node:17-buster-slim

RUN mkdir -p /opt/app
RUN apt-get -y update && \
    apt-get install -y git
WORKDIR /opt/app
RUN npm install -g npm@8.11.0
ADD package.json /opt/app/
#RUN npm update && \
RUN    npm install 

ADD server.js /opt/app/
ADD public/ /opt/app/public
ADD views/ /opt/app/views

EXPOSE 7000

CMD node /opt/app/server.js

