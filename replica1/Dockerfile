FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install
RUN npm install -g nodemon

COPY index.js .

EXPOSE 5000

CMD ["nodemon", "index.js"]
