# 内蔵 PostgreSQL。`ALTEROID_DATABASE_URL` 1本だけから起動できるようにする薄い層
# （`docker/alteroid-db`）を足すためだけに、素の `postgres:17-alpine` へ1段重ねる。
# 能力は増えていない — URL のパースを Node に任せているぶん `nodejs` を足すだけで、
# postgres 本体の起動ロジック（`docker-entrypoint.sh`）には一切手を入れない。
FROM postgres:17-alpine

RUN apk add --no-cache nodejs

COPY alteroid-db /usr/local/bin/alteroid-db
RUN chmod 0755 /usr/local/bin/alteroid-db

ENTRYPOINT ["alteroid-db"]
CMD ["postgres"]
