# 内蔵 PostgreSQL。`ALTEROID_DATABASE_URL` 1本だけから起動できるようにする薄い層
# （`docker/alteroid-db`）を足すためだけに、素の `postgres:17-alpine` へ1段重ねる。
# 能力は増えていない — URL のパースを Node に任せているぶん `nodejs` を足すだけで、
# postgres 本体の起動ロジック（`docker-entrypoint.sh`）には一切手を入れない。
# 取り元は Docker Hub ではなく ECR Public のミラー（同じ digest）。CI の `image` が
# この像もビルドするので、Docker Hub の匿名の取得制限で必須チェックが落ちうる（#4383）。
FROM public.ecr.aws/docker/library/postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24

RUN apk add --no-cache nodejs

COPY alteroid-db /usr/local/bin/alteroid-db
RUN chmod 0755 /usr/local/bin/alteroid-db

ENTRYPOINT ["alteroid-db"]
CMD ["postgres"]
