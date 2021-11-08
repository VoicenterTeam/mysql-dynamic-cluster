create table if not exists node
(
    node_id   tinyint               not null
        primary key,
    node_name varchar(100)          null,
    ip        varchar(100)          null,
    port      smallint default 3306 null,
    constraint unique_port_ip
        unique (ip, port)
);
