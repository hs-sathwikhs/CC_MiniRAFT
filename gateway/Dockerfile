FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install
RUN npm install -g nodemon

COPY server.js .
# assuming public folder as well
COPY public ./public

EXPOSE 8080

CMD ["nodemon", "server.js"]
