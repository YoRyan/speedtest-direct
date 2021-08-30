FROM golang:1-alpine AS build
WORKDIR /src
COPY . .
RUN go mod download
ENV CGO_ENABLED=0 GOOS=linux
RUN go build -a -installsuffix cgo -o ./out/speedtest .

FROM scratch
COPY --from=build /src/out/speedtest /main
COPY ./static static
USER 10001
EXPOSE 8080
CMD ["/main", "-path", "static"]