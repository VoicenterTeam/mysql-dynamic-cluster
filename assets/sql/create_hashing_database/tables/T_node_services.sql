create table if not exists node_services
(
    service_id tinyint not null
    primary key,
    node_id    tinyint not null,
    constraint node_services_node_node_id_fk
    foreign key (node_id) references node (node_id)
);
