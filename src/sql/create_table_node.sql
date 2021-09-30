create table node
(
    node_id   tinyint               not null
        primary key,
    node_name varchar(100)          null,
    ip        varchar(100)          null,
    port      smallint default 3306 null,
    constraint unique_port_ip
        unique (ip, port)
);

create table node_services
(
    service_id tinyint not null
        primary key,
    node_id    tinyint not null,
    constraint node_services_node_node_id_fk
        foreign key (node_id) references node (node_id)
);

create
    definer = root@localhost function FN_GetServiceNodeMapping() returns json
BEGIN

    RETURN (
        SELECT JSON_OBJECTAGG(ns.service_id, ns.node_id) FROM node_services ns
    );
END;

create
    definer = root@localhost procedure SP_NodeInsert(IN _ID tinyint, IN _Name varchar(100), IN _IP varchar(100),
                                                     IN _Port smallint)
BEGIN
    if (select count(node_id) > 0
        from node
        where ip = _IP
          and port = _Port)
    then
        if (select count(node_id)
            from node
            where node_id = _ID
              and node_name != _Name
              and ip = _IP
              and port = _Port) > 0
        then
            select CONCAT('Node with ip ', _IP, ' port ', CAST(_Port AS CHAR), ' and name ',
                          (select node_name from node where node_id = _ID), ' renamed to ', _Name) as Result;
        else
            select CONCAT('Node with ip ', _IP, ' and port ', CAST(_Port AS CHAR), ' already exists') as Result;
        end if;
    else
        select CONCAT('Node with ip ', _IP, ' port ', CAST(_Port AS CHAR), ' and name ', _Name, ' inserted') as Result;
    end if;
    INSERT INTO node (node_id, node_name, ip, port)
    VALUES (_ID, _Name, _IP, _Port)
    ON DUPLICATE KEY UPDATE node_name=_Name, ip=_IP, port=_Port;
END;

create
    definer = root@localhost procedure SP_NodeServiceUpdate(IN _NodeID tinyint, IN _ServiceID smallint)
BEGIN
    INSERT INTO node_services (service_id, node_id)
    VALUES (_ServiceID, _NodeID)
    ON DUPLICATE KEY UPDATE node_id=_NodeID;
END;

create
    definer = root@localhost procedure SP_RemoveNode(IN _ID tinyint)
BEGIN
    delete
    from `mysql-dynamic-cluster`.node
    where node_id = _ID;
end;

create
    definer = root@localhost procedure SP_RemoveService(IN _ID tinyint)
BEGIN
    delete
    from `mysql-dynamic-cluster`.node_services
    where service_id = _ID;
end;

