# Static hosting, nothing else. The app reads dashcam folders in the browser
# and never uploads a byte, so the server has no API, no state and no idea
# what anyone is looking at.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html
# `nginx -t` leaves a root-owned pid file behind, and the unprivileged runtime
# user then cannot start. Test the config, delete the pid file, then chown.
RUN mkdir -p /var/cache/nginx /var/run/nginx \
 && nginx -t \
 && rm -f /var/run/nginx/nginx.pid \
 && chown -R nginx:nginx /var/cache/nginx /var/run/nginx /usr/share/nginx/html
USER nginx
EXPOSE 8080
