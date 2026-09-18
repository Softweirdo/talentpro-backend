# Base image
FROM node:18

# Create app directory
WORKDIR /index.js

# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

# Install app dependencies
RUN npm install -f

# Bundle app source
COPY . .
# COPY .env

# # envs
# ENV PORT 8080
# # expose working port
# EXPOSE $PORT

# Start the server using the production build
CMD [ "npm", "start" ]
